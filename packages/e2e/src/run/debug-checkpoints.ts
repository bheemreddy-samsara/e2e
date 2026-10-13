/** Awaited, bounded public-step debugging on the existing attempt session. */

import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareObservation } from "../agent/observation.ts";
import type { TargetSession, ViewportSize } from "../engine/surface.ts";
import { classifyError, ConfigurationError, TestTimeoutError, truncateUtf8 } from "../internal/errors.ts";
import { timestamp } from "../internal/ids.ts";
import { abortError, cancelledError, withAbort } from "../internal/time.ts";
import type { AttemptBudget } from "./budget.ts";
import { associateDebugCheckpoint, bindDebugEvidenceBytes, debugEvidenceBytesProven, debugEvidenceProven, debugEvidenceRegistration } from "./artifacts.ts";
import type { ClosingRecord } from "./execute.ts";
import type { ArtifactRegistration, ArtifactSink } from "./fixtures.ts";
import { prospectiveSecretResolutionsProven, type SessionSecrecy } from "./secrecy.ts";
import type { StepRecord } from "./steps.ts";

export interface DebugCheckpointPolicy {
  /** Request masked pixels for debug only; default false. Does not enable model vision. */
  readonly pixels?: boolean;
  /** Public steps with before/after checkpoints; default 50, hard ceiling 100. */
  readonly maxSteps?: number;
  /** Total retained semantic text and image bytes; default 8 MiB, ceiling 16 MiB. */
  readonly maxBytes?: number;
  /** Each single capture gets at most this many ms and the remaining session budget; default 1000, ceiling 5000. */
  readonly captureTimeout?: number;
  /** Artifacts and checkpoints kept at close; default retain-on-failure. */
  readonly retain?: "on" | "retain-on-failure";
}

/** Why a checkpoint could not capture bounded evidence. */
export type DebugCheckpointUnavailableReason = "UNSUPPORTED_CAPABILITY" | "CAPTURE_UNAVAILABLE" | "CAPTURE_TIMEOUT" | "CANCELLED" | "EVIDENCE_LIMIT";

/** Safe evidence of a public-step boundary, never a model request or a raw engine tree. */
export interface DebugCheckpoint {
  readonly format: "debug-checkpoint-1";
  readonly id: string;
  readonly attemptId: string;
  readonly stepId: string;
  readonly stepIndex: number;
  readonly phase: "before" | "after";
  /** When this checkpoint was attempted, including unsuccessful captures. */
  readonly attemptedAt: string;
  /** Adapter-minted identity and timestamp, present only with a valid capture viewport. */
  readonly observationId?: string;
  readonly capturedAt?: string;
  readonly viewport?: { readonly width: number; readonly height: number; readonly scale?: number };
  readonly semantics:
    | { readonly status: "available"; readonly text: string; readonly truncated: boolean }
    | { readonly status: "unavailable"; readonly reason: DebugCheckpointUnavailableReason };
  readonly image:
    | { readonly status: "pending" }
    | { readonly status: "available"; readonly artifactId: string }
    | { readonly status: "withheld"; readonly reason: "NOT_REQUESTED" | "PIXEL_TAINTED" | "MASKING_UNPROVEN" }
    | { readonly status: "unavailable"; readonly reason: DebugCheckpointUnavailableReason | "ARTIFACT_UNAVAILABLE" };
  /** The JSON log artifact id, populated at close when retention permits it. */
  readonly artifactId?: string;
}

type FormattedField = Parameters<NonNullable<Parameters<typeof prepareObservation>[1]["onField"]>>[0];

type CheckpointBoundary = Pick<DebugCheckpoint, "format" | "id" | "attemptId" | "stepId" | "stepIndex" | "phase" | "attemptedAt">;

interface PendingCheckpoint {
  readonly boundary: CheckpointBoundary;
  /** Source-selected minimal protocol cannot be upgraded by later record fields. */
  readonly unavailable: boolean;
  record: DebugCheckpoint;
  /** Assigned only by the sink after publication; never spread into protocol bytes. */
  artifactId?: string;
  readonly step: StepRecord;
  readonly pixels?: Uint8Array;
  readonly pixelRegistration?: ArtifactRegistration;
  readonly observationRevision?: string;
  /** Reserved at capture so later redaction cannot expand beyond the content quota. */
  readonly textBytes?: number;
  /** Formatter-owned scalar boundaries in bounded safe text; no raw fields or trees are retained. */
  readonly fields?: readonly FormattedField[];
}

/** Copies only finite, positive dimensions admitted by the checkpoint schema. */
function checkpointViewport(viewport: ViewportSize): DebugCheckpoint["viewport"] {
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;
  const { width, height } = viewport;
  const scale = "scale" in viewport ? viewport.scale : undefined;
  if (!positive(width) || !positive(height)) return undefined;
  return { width, height, ...(scale === undefined || !positive(scale) ? {} : { scale }) };
}

/** Decodes a quota-cut JSON field, discarding at most one unfinished escape sequence. */
function decodeCutField(token: string): string | undefined {
  for (let trim = 0; trim <= 5; trim++) {
    try { return JSON.parse(`${token.slice(0, token.length - trim)}"`) as string; } catch { /* Try before the unfinished escape. */ }
  }
  return undefined;
}

/** Owns and validates enumerable policy data before reservation, without invoking an engine. */
export function validateDebugCheckpoints(input: DebugCheckpointPolicy | undefined): DebugCheckpointPolicy | undefined {
  if (input === undefined) return;
  if (input === null || typeof input !== "object" || Array.isArray(input)) throw new ConfigurationError("INVALID_CONFIG", "debugCheckpoints must be an object");
  const policy = { ...input };
  for (const key of Object.keys(policy)) {
    if (!["pixels", "maxSteps", "maxBytes", "captureTimeout", "retain"].includes(key)) throw new ConfigurationError("INVALID_CONFIG", `unknown debugCheckpoints option ${key}`);
  }
  if (policy.pixels !== undefined && typeof policy.pixels !== "boolean") throw new ConfigurationError("INVALID_CONFIG", "debugCheckpoints.pixels must be boolean");
  for (const [key, value, ceiling] of [["maxSteps", policy.maxSteps, 100], ["maxBytes", policy.maxBytes, 16 * 1024 * 1024], ["captureTimeout", policy.captureTimeout, 5000]] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0 || value > ceiling)) throw new ConfigurationError("INVALID_CONFIG", `debugCheckpoints.${key} must be a positive integer no greater than ${ceiling}`);
  }
  if (policy.retain !== undefined && policy.retain !== "on" && policy.retain !== "retain-on-failure") throw new ConfigurationError("INVALID_CONFIG", "debugCheckpoints.retain must be on or retain-on-failure");
  return Object.freeze(policy);
}

/** One attempt owns the evidence queue, memory quota, retention, and artifact association. */
export class DebugCheckpoints {
  private readonly nested = new AsyncLocalStorage<boolean>();
  private tail: Promise<unknown> = Promise.resolve();
  private readonly pending: PendingCheckpoint[] = [];
  private selected = 0;
  private bytes = 0;
  private closed = false;
  private exhausted = false;

  constructor(private readonly options: {
    readonly policy: DebugCheckpointPolicy;
    readonly session: TargetSession;
    readonly secrecy: SessionSecrecy;
    readonly budget: AttemptBudget;
    readonly artifacts: ArtifactSink;
    readonly runId: string;
    readonly attemptId: string;
    readonly maxObservationBytes: number;
    readonly appOrigin: string | undefined;
    readonly onDeadline: (error: TestTimeoutError) => void;
  }) {}

  /** Snapshot copies prevent a viewer from altering SDK-owned evidence. */
  all(): readonly DebugCheckpoint[] {
    return structuredClone(this.pending.map((pending) => pending.artifactId === undefined ? this.view(pending) : { ...this.view(pending), artifactId: pending.artifactId }));
  }

  /** Serializes top-level public calls while allowing nested fixture calls to complete. */
  run<T>(step: StepRecord, body: () => Promise<T>): Promise<T> {
    if (this.nested.getStore() === true) return body();
    const work = this.tail.then(() => this.nested.run(true, async () => {
      const capture = !this.closed && this.selected++ < (this.options.policy.maxSteps ?? 50);
      if (capture) await this.capture(step, "before");
      let passed = false;
      try {
        this.guardDeadline();
        const result = await withAbort(body, this.options.budget.signal, cancelledError);
        passed = true;
        return result;
      } finally {
        if (capture && !this.closed) await this.capture(step, "after");
        if (passed) this.guardDeadline();
      }
    }));
    this.tail = work.catch(() => undefined);
    return work;
  }

  /** Publishes after required cleanup/retirement; permanently drops content whose privacy is unproven. */
  async finish(failed: boolean, cleanupProven: boolean, closing?: ClosingRecord): Promise<void> {
    await this.tail;
    this.closed = true;
    const effectiveStatus = closing?.videoRetentionStatus?.();
    const retainFailure = effectiveStatus === undefined ? failed : effectiveStatus !== "passed" && effectiveStatus !== "skipped";
    if (!retainFailure && this.options.policy.retain !== "on") {
      this.pending.length = 0;
      this.bytes = 0;
      return;
    }
    const { artifacts, secrecy } = this.options;
    if (!cleanupProven || !prospectiveSecretResolutionsProven(secrecy.ledger)) {
      for (let index = 0; index < this.pending.length; index++) {
        const pending = this.pending[index]!;
        // Erase text, field offsets and pixels, so late provider completion cannot resurrect them.
        this.pending[index] = { boundary: pending.boundary, unavailable: true, step: pending.step, record: this.unproven(pending) };
      }
      this.bytes = 0;
    }
    for (const pending of this.pending) {
      let record = this.view(pending);
      const boundary = pending.boundary;
      const stem = `debug/step-${boundary.stepIndex}-${boundary.phase}`;
      const association = { checkpointId: boundary.id, phase: boundary.phase, observationId: record.observationId ?? null, observationRevision: record.observationId === undefined ? null : pending.observationRevision ?? null };
      const imageRegistration = pending.pixelRegistration === undefined ? undefined : associateDebugCheckpoint(pending.pixelRegistration, association, { stepId: boundary.stepId, startedAt: record.capturedAt ?? boundary.attemptedAt });
      if (record.image.status === "pending" && (record.observationId === undefined || imageRegistration === undefined || !debugEvidenceProven(artifacts, imageRegistration) || pending.pixels === undefined || !debugEvidenceBytesProven(artifacts, imageRegistration, pending.pixels))) {
        record = { ...record, image: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" } };
      }
      if (pending.pixels !== undefined && imageRegistration !== undefined && record.image.status === "pending") {
        try {
          mkdirSync(path.join(artifacts.dir, "debug"), { recursive: true });
          writeFileSync(path.join(artifacts.dir, `${stem}.png`), pending.pixels);
          const artifactId = artifacts.register("screenshot", `${stem}.png`, imageRegistration);
          pending.step.artifacts.push(artifactId);
          record = { ...record, image: { status: "available", artifactId } };
        } catch {
          record = { ...record, image: { status: "unavailable", reason: "ARTIFACT_UNAVAILABLE" } };
        }
      }
      try {
        const protocolOnly = pending.unavailable || record.semantics.status === "unavailable" && record.observationId === undefined && record.image.status === "unavailable";
        const registration = associateDebugCheckpoint(debugEvidenceRegistration(artifacts, protocolOnly ? "checkpoint-unavailable" : "checkpoint-json"), association, { stepId: boundary.stepId, startedAt: boundary.attemptedAt });
        const bytes = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
        bindDebugEvidenceBytes(artifacts, registration, bytes);
        if (!debugEvidenceBytesProven(artifacts, registration, bytes)) {
          pending.record = this.unproven(pending);
          continue;
        }
        mkdirSync(path.join(artifacts.dir, "debug"), { recursive: true });
        writeFileSync(path.join(artifacts.dir, `${stem}.json`), bytes);
        const artifactId = artifacts.register("log", `${stem}.json`, registration);
        pending.artifactId = artifactId;
        record = { ...record, artifactId };
        pending.step.artifacts.push(artifactId);
      } catch {
        // Debug evidence never changes an operation or cleanup result.
      }
      // Preserve the bounded source and its offsets for subsequent ledger-aware reads.
      pending.record = { ...record, semantics: pending.record.semantics };
    }
  }

  /** Only SDK-minted boundary identity survives an incomplete privacy proof. */
  private unproven(pending: PendingCheckpoint): DebugCheckpoint {
    const boundary = pending.boundary;
    return { format: "debug-checkpoint-1", id: boundary.id, attemptId: boundary.attemptId, stepId: boundary.stepId,
      stepIndex: boundary.stepIndex, phase: boundary.phase, attemptedAt: boundary.attemptedAt,
      semantics: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" }, image: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" } };
  }

  /** Redacts decoded scalars at their actual cut boundary before re-rendering or quota clipping. */
  private view(pending: PendingCheckpoint): DebugCheckpoint {
    if (!prospectiveSecretResolutionsProven(this.options.secrecy.ledger)) return this.unproven(pending);
    const record: DebugCheckpoint = this.options.secrecy.exposure.withholdsPixels && pending.record.image.status === "pending"
      ? { ...pending.record, image: { status: "withheld", reason: "PIXEL_TAINTED" } }
      : pending.record;
    if (record.semantics.status !== "available") return record;
    const ledger = this.options.secrecy.ledger;
    const source = record.semantics.text;
    const parts: string[] = [];
    let cursor = 0;
    for (const { start, end, contentEnd, quoted, cut } of pending.fields ?? []) {
      const retainedEnd = Math.min(end, source.length);
      const boundary = Math.min(contentEnd, source.length);
      const token = source.slice(start, boundary);
      const field = quoted ? decodeCutField(token) : token;
      if (field === undefined) return { ...record, semantics: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" } };
      const redacted = ledger.redactFragments(cut || retainedEnd < end ? ledger.redactCut(field) : ledger.redact(field));
      const rendered = quoted ? JSON.stringify(redacted).slice(0, -1) : redacted;
      parts.push(source.slice(cursor, start), redacted === field ? token : rendered, source.slice(boundary, retainedEnd));
      cursor = retainedEnd;
    }
    parts.push(source.slice(cursor));
    const redacted = ledger.redactCut(ledger.redactFragments(parts.join("")));
    const text = truncateUtf8(redacted, pending.textBytes ?? 0);
    return { ...record, semantics: { status: "available", text, truncated: record.semantics.truncated || text !== redacted } };
  }

  /** Evidence cannot extend the session clock or dispatch an action after using its last budget. */
  private guardDeadline(): void {
    if (this.options.budget.signal.aborted) throw abortError(this.options.budget.signal, cancelledError);
    if (this.exhausted || this.options.budget.deadline.expired()) {
      const error = new TestTimeoutError("session deadline exceeded during debug checkpoint");
      this.options.onDeadline(error);
      throw error;
    }
  }

  /** One atomic capture, no settling loop, retries, model work, or second session. */
  private async capture(step: StepRecord, phase: DebugCheckpoint["phase"]): Promise<void> {
    const { policy, budget, session, secrecy } = this.options;
    const attemptedAt = timestamp();
    const base = Object.freeze({
      format: "debug-checkpoint-1" as const,
      id: `${step.id}:checkpoint:${phase}`, attemptId: this.options.attemptId, stepId: step.id, stepIndex: step.index, phase, attemptedAt,
    });
    const missing = (reason: DebugCheckpointUnavailableReason): void => {
      this.pending.push({ boundary: base, unavailable: true, step, record: { ...base, semantics: { status: "unavailable", reason }, image: { status: "unavailable", reason } } });
    };
    if (budget.signal.aborted) { missing("CANCELLED"); return; }
    if (budget.deadline.expired()) { missing("CAPTURE_TIMEOUT"); return; }
    const remaining = (policy.maxBytes ?? 8 * 1024 * 1024) - this.bytes;
    if (remaining <= 0) { missing("EVIDENCE_LIMIT"); return; }
    // An unused or already-resolved provider can mint a new secret during future recovery.
    // Do not retain source content or request pixels under an unproven prospective contract.
    if (!prospectiveSecretResolutionsProven(secrecy.ledger)) { missing("CAPTURE_UNAVAILABLE"); return; }
    const remainingMs = budget.deadline.remaining();
    const deadlineLimited = (policy.captureTimeout ?? 1000) >= remainingMs;
    const timeoutMs = Math.min(policy.captureTimeout ?? 1000, remainingMs);
    // Session deadlines allow fractional milliseconds; Node timeout signals require integers.
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(timeoutMs)));
    const signal = AbortSignal.any([budget.signal, timeout]);
    const tainted = secrecy.exposure.withholdsPixels;
    // The public pixel media type is PNG: even its signature requires eight bytes.
    // This floor is not a compressed-size estimate or an engine allocation ceiling.
    const pixelBudgetDenied = remaining < 8;
    const pixels = policy.pixels === true && !tainted && !pixelBudgetDenied;
    const pixelRegistration = pixels ? debugEvidenceRegistration(this.options.artifacts) : undefined;
    try {
      const raw = await withAbort(() => session.observe({
        signal, timeoutMs, runId: this.options.runId, attemptId: this.options.attemptId, origin: "test",
      }, { pixels, pixelFallback: pixels }), signal, cancelledError);
      if (signal.aborted || this.closed) return;
      const maxTextBytes = Math.min(64 * 1024, this.options.maxObservationBytes, remaining);
      const fields: FormattedField[] = [];
      let provenanceLimited = false;
      const observation = prepareObservation(raw, {
        redact: secrecy.ledger.redact, redactCut: secrecy.ledger.redactCut, withholdSelections: true,
        onField: (field) => {
          // Bound scalar descriptors separately from the retained content-byte quota.
          // Nothing beyond the retained content can be needed for a later ledger-aware read.
          if (field.start >= maxTextBytes || provenanceLimited) return;
          if (fields.length >= 2048) { provenanceLimited = true; return; }
          fields.push(field);
        },
        maxBytes: maxTextBytes,
        pixelsAllowed: !secrecy.exposure.withholdsPixels, appOrigin: this.options.appOrigin,
      });
      if (provenanceLimited) { missing("EVIDENCE_LIMIT"); return; }
      const text = truncateUtf8(observation.text, maxTextBytes);
      const retainedFields = fields.filter((field) => field.start < text.length);
      this.bytes += Buffer.byteLength(text);
      let image: DebugCheckpoint["image"];
      let imageBytes: Uint8Array | undefined;
      if (policy.pixels !== true) image = { status: "withheld", reason: "NOT_REQUESTED" };
      else if (secrecy.exposure.withholdsPixels) image = { status: "withheld", reason: "PIXEL_TAINTED" };
      else if (pixelBudgetDenied) image = { status: "unavailable", reason: "EVIDENCE_LIMIT" };
      else if (observation.pixels === undefined) image = observation.kind === "semantic" && observation.pixelsWithheld !== undefined
        ? { status: "withheld", reason: observation.pixelsWithheld }
        : { status: "unavailable", reason: "UNSUPPORTED_CAPABILITY" };
      else if (observation.pixels.data.byteLength > Math.min(1024 * 1024, (policy.maxBytes ?? 8 * 1024 * 1024) - this.bytes)) image = { status: "unavailable", reason: "EVIDENCE_LIMIT" };
      else {
        imageBytes = Uint8Array.from(observation.pixels.data);
        if (pixelRegistration !== undefined) bindDebugEvidenceBytes(this.options.artifacts, pixelRegistration, imageBytes);
        this.bytes += imageBytes.byteLength;
        image = { status: "pending" };
      }
      const viewport = checkpointViewport(raw.viewport);
      this.pending.push({
        boundary: base, unavailable: false, step, textBytes: Buffer.byteLength(text), fields: retainedFields, ...(imageBytes === undefined ? {} : { pixels: imageBytes, ...(pixelRegistration === undefined ? {} : { pixelRegistration }) }),
        ...(viewport === undefined ? {} : { observationRevision: raw.revision }),
        record: { ...base, ...(viewport === undefined ? {} : { observationId: `${this.options.attemptId}:${raw.revision}`, capturedAt: raw.capturedAt, viewport }),
          semantics: observation.kind === "semantic" ? { status: "available", text, truncated: observation.truncated || text !== observation.text } : { status: "unavailable", reason: "UNSUPPORTED_CAPABILITY" }, image },
      });
    } catch (cause) {
      // A timer can fire a millisecond early; consuming the deadline-limited capture still exhausts the budget.
      if (timeout.aborted && deadlineLimited) this.exhausted = true;
      missing(budget.signal.aborted ? "CANCELLED" : timeout.aborted ? "CAPTURE_TIMEOUT" : classifyError(cause).code === "UNSUPPORTED_CAPABILITY" ? "UNSUPPORTED_CAPABILITY" : "CAPTURE_UNAVAILABLE");
    }
  }
}
