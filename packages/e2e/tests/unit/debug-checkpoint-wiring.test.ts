/** Private cross-feature contracts, synthetic capture only. */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as registrations from "../../src/run/artifacts.ts";
import { DebugCheckpoints } from "../../src/run/debug-checkpoints.ts";
import { AttemptBudget } from "../../src/run/budget.ts";
import { Deadline } from "../../src/internal/time.ts";
import { sessionSecrecy, trackSecretResolution } from "../../src/run/secrecy.ts";
import type { TargetSession } from "../../src/engine/surface.ts";
import { TargetExecutor } from "../../src/run/execute.ts";
import { openHost } from "../../src/runner.ts";
import { createFakeEngine, FAKE_APP } from "../helpers/fake-engine.ts";
import type { StepRecord } from "../../src/run/steps.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const association = { checkpointId: "opaque:boundary", phase: "before" as const, observationId: "opaque:capture", observationRevision: "opaque:revision" };
/** Owns the attempt and actual observation source used by the checkpoint collector. */
function harness(options: { missing?: boolean; maxBytes?: number; duringCapture?: () => void } = {}) {
  const dir = mkdtempSync(`${os.tmpdir()}/checkpoint-wiring-`); dirs.push(dir);
  const secrecy = sessionSecrecy({} as TargetSession, new Map());
  const artifacts = registrations.createAttemptArtifacts({ artifactsRoot: dir, segments: [], attemptId: "attempt", secrecy: () => secrecy });
  const session = { observe: async () => {
    options.duringCapture?.();
    return { kind: "semantic", tree: { ref: { id: "root", revision: "opaque" }, role: "status", name: "safe" }, root: { id: "root", revision: "opaque" },
      revision: "opaque", capturedAt: new Date().toISOString(), viewport: { width: options.missing ? 0 : 1, height: 1 }, truncated: false,
      redaction: { secureNodeCount: 0, maskedRegionCount: 0 }, pixels: { data: Uint8Array.from([1, 2, 3]), mediaType: "image/png", width: 1, height: 1, scale: 1 } };
  } } as unknown as TargetSession;
  const collector = new DebugCheckpoints({ policy: { pixels: true, ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }) }, session, secrecy,
    artifacts: artifacts.sink, budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)), runId: "run", attemptId: "attempt", maxObservationBytes: 1000, appOrigin: undefined, onDeadline: () => undefined });
  const step = { id: "attempt:0", index: 0, artifacts: [] } as unknown as StepRecord;
  return { collector, artifacts, secrecy, capture: () => collector.run(step, async () => undefined) };
}

describe("checkpoint retention closing facts", () => {
  it.each([
    ["external unexpected failure", false, "failed", true],
    ["expected external failure", false, "passed", false],
    ["external skip", false, "skipped", false],
    ["SDK failure", true, "failed", true],
    ["unexpected external timeout", false, "timed-out", true],
  ] as const)("uses effective retention for %s", async (_name, failed, status, keep) => {
    const h = harness(); await h.capture();
    await h.collector.finish(failed, true, { status: failed ? "failed" : "passed", cleanup: "complete", videoRetentionStatus: () => status });
    expect(h.collector.all()).toHaveLength(keep ? 2 : 0);
  });
  it("preserves SDK-only fallback", async () => { const h = harness(); await h.capture(); await h.collector.finish(true, true); expect(h.collector.all()).toHaveLength(2); });
});

describe("ticketed checkpoint registration", () => {
  it("registers proven SDK semantics and pixels with actual capture association", async () => {
    const h = harness(); await h.capture(); await h.collector.finish(true, true); await h.artifacts.settle();
    expect(h.artifacts.debugEvidence.size).toBe(4);
    for (const record of h.collector.all()) {
      for (const id of [record.artifactId!, record.image.status === "available" ? record.image.artifactId : "missing"]) {
        expect(h.artifacts.debugRedactionProven(id)).toBe(true);
        expect(h.artifacts.debugCheckpoints.get(id)).toEqual({ checkpointId: record.id, phase: record.phase, observationId: record.observationId, observationRevision: "opaque" });
      }
    }
  });
  it.each(["copy", "forge", "other sink", "reuse"])("rejects a %s ticket", (mode) => {
    const h = harness(), other = harness();
    const ticket = registrations.debugEvidenceRegistration(h.artifacts.sink);
    if (mode === "reuse") {
      const original = h.artifacts.sink.register("screenshot", "original.png", ticket);
      expect(h.artifacts.debugRedactionProven(original)).toBe(true);
    }
    const sink = mode === "other sink" ? other.artifacts : h.artifacts;
    const rejected = sink.sink.register("screenshot", "rejected.png", mode === "copy" ? { ...ticket } : mode === "forge" ? { debugEvidence: true } : ticket);
    expect(sink.debugRedactionProven(rejected)).toBe(false);
  });
  it.each(["pending", "stale", "filled", "failed"])("withholds %s pixel proof", async (mode) => {
    const h = harness();
    let resolve!: () => void;
    const waiting = new Promise<void>((done) => { resolve = done; });
    const work = mode === "pending" || mode === "failed" ? trackSecretResolution(h.secrecy.ledger, async () => { await waiting; if (mode === "failed") throw new Error("provider failed"); }) : Promise.resolve();
    const ticket = registrations.debugEvidenceRegistration(h.artifacts.sink);
    if (mode === "stale") h.secrecy.ledger.register("late", "late-value");
    if (mode === "filled") h.secrecy.exposure.raise("filled");
    resolve(); await work.catch(() => undefined);
    const id = h.artifacts.sink.register("screenshot", "image.png", ticket);
    expect(h.artifacts.debugRedactionProven(id)).toBe(false);
  });
  it("does not publish pre-resolution pixels with a stale capture ticket", async () => {
    const h = harness(); await h.capture(); h.secrecy.ledger.register("late", "late-secret"); await h.collector.finish(true, true);
    expect(h.artifacts.records.every(({ kind }) => kind === "log")).toBe(true);
    expect(h.collector.all().every(({ image }) => image.status === "unavailable" && image.reason === "CAPTURE_UNAVAILABLE")).toBe(true);
    for (const record of h.artifacts.records) expect(h.artifacts.debugRedactionProven(record.id)).toBe(true);
  });
  it("permits finally redacted semantics after fill, never old pixels", async () => {
    const h = harness(); await h.capture(); h.secrecy.exposure.raise("filled"); await h.collector.finish(true, true);
    expect(h.artifacts.records.every(({ kind }) => kind === "log")).toBe(true);
    for (const record of h.artifacts.records) expect(h.artifacts.debugRedactionProven(record.id)).toBe(true);
  });
  it.each(["missing", "overflow"])("records explicit null association for %s evidence", async (mode) => {
    const h = harness(mode === "missing" ? { missing: true } : { maxBytes: 1 }); await h.capture(); await h.collector.finish(true, true);
    if (mode === "missing") expect(h.artifacts.records.every(({ kind }) => kind === "log")).toBe(true);
    const last = h.collector.all()[1]!;
    expect(h.artifacts.debugCheckpoints.get(last.artifactId!)).toEqual({ checkpointId: last.id, phase: "after", observationId: null, observationRevision: null });
  });
  it("rechecks proof at export and refuses absent secrecy or unknown IDs", () => {
    const h = harness();
    const ticket = registrations.debugEvidenceRegistration(h.artifacts.sink);
    const id = h.artifacts.sink.register("screenshot", "image.png", ticket);
    expect(h.artifacts.debugRedactionProven(id)).toBe(true);
    h.secrecy.ledger.register("later", "rotating-value");
    expect(h.artifacts.debugRedactionProven(id)).toBe(false);
    expect(h.artifacts.debugRedactionProven("not-registered")).toBe(false);
    const absent = registrations.createAttemptArtifacts({ artifactsRoot: h.artifacts.dir, segments: [], attemptId: "no-secrecy" });
    const absentId = absent.sink.register("screenshot", "absent.png", registrations.debugEvidenceRegistration(absent.sink));
    expect(absent.debugRedactionProven(absentId)).toBe(false);
  });
  it("does not authorize a non-log file with a semantic ticket", () => {
    const h = harness();
    const ticket = registrations.associateDebugCheckpoint(registrations.debugEvidenceRegistration(h.artifacts.sink, "checkpoint-json"), association, {});
    const id = h.artifacts.sink.register("screenshot", "not-semantics.png", ticket);
    expect(h.artifacts.debugRedactionProven(id)).toBe(false);
    expect(h.artifacts.debugEvidence.has(id)).toBe(false);
  });
  it("copies bounded identities and rejects overflow instead of guessing", () => {
    const h = harness();
    const ticket = registrations.debugEvidenceRegistration(h.artifacts.sink, "checkpoint-json");
    const source = { ...association };
    registrations.associateDebugCheckpoint(ticket, source, { stepId: "step", startedAt: "time" });
    source.observationId = "changed";
    const id = h.artifacts.sink.register("log", "semantic.json", ticket);
    expect(h.artifacts.debugCheckpoints.get(id)).toEqual(association);
    const invalid = registrations.debugEvidenceRegistration(h.artifacts.sink, "checkpoint-json");
    registrations.associateDebugCheckpoint(invalid, { ...association, observationId: "x".repeat(1025) }, {});
    const invalidId = h.artifacts.sink.register("log", "invalid.json", invalid);
    expect(h.artifacts.debugRedactionProven(invalidId)).toBe(false);
    expect(h.artifacts.debugCheckpoints.has(invalidId)).toBe(false);
  });
});


describe("standalone checkpoint finalization seam", () => {
  it.each(["unexpected", "expected", "skip", "SDK failure", "finalizer failure"])("selects after required video finalization for %s", async (mode) => {
    const dir = mkdtempSync(`${os.tmpdir()}/checkpoint-close-`); dirs.push(dir);
    const fake = createFakeEngine({ tree: { ref: { id: "root", revision: "" }, role: "status", name: "finalizer-secret" }, ...(mode === "SDK failure" ? { onNavigate: () => { throw new Error("SDK body failed"); } } : {}) });
    const closeSession = TargetExecutor.prototype.closeSession;
    let finalized = false, writtenTooSoon = false, retirements = 0, retentionCalls = 0, retentionTooSoon = false;
    vi.spyOn(TargetExecutor.prototype, "closeSession").mockImplementation(async function (this: TargetExecutor, session, closing, record, sink, errors) {
      await closeSession.call(this, session, closing, record, sink, errors);
      Object.assign(record, { videoRetentionStatus: () => { retentionCalls++; retentionTooSoon ||= !finalized; return mode === "expected" ? "passed" : mode === "skip" ? "skipped" : "failed"; } });
      record.finalizeVideo = async () => {
        writtenTooSoon = existsSync(`${sink.dir}/debug`);
        await trackSecretResolution(sessionSecrecy(session, new Map()).ledger, async () => { sessionSecrecy(session, new Map()).ledger.register("finalizer", "finalizer-secret"); });
        finalized = true;
        if (mode === "finalizer failure") throw new Error("required finalization failed");
      };
      retirements++;
    });
    const host = await openHost({ cwd: dir, env: {}, config: { targets: [{ name: "synthetic", platform: "synthetic", engine: fake.engine, app: FAKE_APP }] } });
    try {
      const session = await host.openSession({ name: "private finalize seam", debugCheckpoints: {} });
      if (mode === "SDK failure") await expect(session.fixtures.app.open()).rejects.toBeDefined();
      else await session.fixtures.app.open();
      await session.close();
      expect(retentionCalls).toBe(1); expect(retentionTooSoon).toBe(false);
      expect(finalized).toBe(true); expect(writtenTooSoon).toBe(false); expect(retirements).toBe(1);
      const checkpoints = session.checkpoints();
      if (mode === "expected" || mode === "skip") expect(checkpoints).toEqual([]);
      else {
        expect(checkpoints).toHaveLength(2);
        expect(JSON.stringify(checkpoints)).not.toContain("finalizer-secret");
        if (mode === "finalizer failure") expect(checkpoints.every(({ semantics }) => semantics.status === "unavailable")).toBe(true);
      }
    } finally { await host.close(); }
  });
});
