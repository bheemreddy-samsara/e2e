/** Private original-ticket/queue seams, not a public ingress or sandbox claim. */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/resolve.ts";
import type { TargetSession } from "../../src/engine/surface.ts";
import type { ArtifactRegistration, ArtifactSink } from "../../src/run/fixtures.ts";
import * as custody from "../../src/run/artifacts.ts";
import { DebugCheckpoints, type DebugCheckpoint } from "../../src/run/debug-checkpoints.ts";
import { AttemptBudget } from "../../src/run/budget.ts";
import { Deadline } from "../../src/internal/time.ts";
import { sessionSecrecy } from "../../src/run/secrecy.ts";
import type { StepRecord } from "../../src/run/steps.ts";
import type { StoredArtifact } from "../../src/types.ts";

const writes = vi.hoisted(() => ({ all: [] as { file: string; bytes: Uint8Array }[] }));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    writes.all.push({ file: String(args[0]), bytes: typeof args[1] === "string" ? Buffer.from(args[1]) : Uint8Array.from(args[1] as Uint8Array) });
    return fs.writeFileSync(...args);
  } };
});
const io = vi.hoisted(() => ({ afterRead: undefined as undefined | ((file: string, bytes: Uint8Array) => Promise<void>) }));
vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await fs.readFile(...args);
    if (io.afterRead !== undefined && bytes instanceof Uint8Array) await io.afterRead(String(args[0]), bytes);
    return bytes;
  } };
});
const roots: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=", "base64");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
afterEach(() => { vi.restoreAllMocks(); io.afterRead = undefined; writes.all.length = 0; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** Real collector/sink source joins with synthetic observations and no external I/O. */
function setup(mode: "none" | "literal" | "env" | "opaque" = "opaque", store = true, missing = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "cp-protocol-custody-")); roots.push(root);
  let providers = 0, getters = 0, observations = 0;
  const config = resolveConfig({ targets: [{ name: "synthetic", platform: "synthetic" }], ...(mode === "none" ? {} : {
    secrets: { token: mode === "literal" ? "protocol-secret-A51" : () => { providers++; return "protocol-secret-A51"; } },
  }) }, { projectRoot: root, env: mode === "env" ? { E2E_SECRET_TOKEN: "protocol-secret-A51" } : {} });
  const engineBytes = Uint8Array.from(png);
  const session = { observe: async () => {
    observations++;
    if (missing) throw new Error("capture unavailable");
    return { kind: "semantic", tree: { ref: { id: "root", revision: "rev" }, role: "status", name: "public protocol-secret-A51" },
      root: { id: "root", revision: "rev" }, revision: "rev", capturedAt: new Date().toISOString(), viewport: { width: 1, height: 1 }, truncated: false,
      redaction: { secureNodeCount: 0, maskedRegionCount: 0 }, pixels: { data: engineBytes, mediaType: "image/png", width: 1, height: 1, scale: 1 } };
  } } as unknown as TargetSession;
  const secrecy = sessionSecrecy(session, config.allSecrets);
  if (mode === "opaque") Object.defineProperty(config.allSecrets.get("token")!, "value", {
    configurable: true, get() { getters++; throw new Error("proof must not read getter"); },
  });
  sessionSecrecy(session, config.allSecrets);
  const puts: StoredArtifact[] = [];
  const artifacts = custody.createAttemptArtifacts({ artifactsRoot: root, segments: [], attemptId: "attempt", secrecy: () => secrecy,
    ...(store ? { store: { async put(artifact: StoredArtifact) { puts.push({ ...artifact, bytes: Uint8Array.from(artifact.bytes) }); return { ref: artifact.sha256 }; } } } : {}),
  });
  const collector = new DebugCheckpoints({ policy: { retain: "on", pixels: true }, session, secrecy, artifacts: artifacts.sink,
    budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)), runId: "run", attemptId: "attempt",
    maxObservationBytes: 65536, appOrigin: undefined, onDeadline: () => undefined });
  const step = { id: "attempt:0", index: 0, artifacts: [] } as unknown as StepRecord;
  return { artifacts, collector, puts, secrecy, engineBytes, step, session,
    capture: () => collector.run(step, async () => undefined), finish: async () => { await collector.finish(false, true); await artifacts.settle(); },
    counts: () => ({ providers, getters, observations }) };
}
/** Baseline fallback demonstrates existing authorization rather than only missing ABI symbols. */
function bind(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array): void {
  const helper = Reflect.get(custody, "bindDebugEvidenceBytes") as undefined | ((sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array) => void);
  helper?.(sink, registration, bytes);
}
function proven(sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array): boolean {
  const helper = Reflect.get(custody, "debugEvidenceBytesProven") as undefined | ((sink: ArtifactSink, registration: ArtifactRegistration, bytes: Uint8Array) => boolean);
  return helper === undefined ? custody.debugEvidenceProven(sink, registration) : helper(sink, registration, bytes);
}
function unavailableTicket(h: ReturnType<typeof setup>) {
  return custody.associateDebugCheckpoint(custody.debugEvidenceRegistration(h.artifacts.sink, "checkpoint-unavailable"),
    { checkpointId: "attempt:0:checkpoint:before", phase: "before", observationId: null, observationRevision: null },
    { stepId: "attempt:0", startedAt: "2026-01-01T00:00:00.000Z" });
}
function minimal() {
  return { format: "debug-checkpoint-1", id: "attempt:0:checkpoint:before", attemptId: "attempt", stepId: "attempt:0", stepIndex: 0, phase: "before",
    attemptedAt: "2026-01-01T00:00:00.000Z", semantics: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" }, image: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" } };
}
const faults = ["extra-prose", "extra-capture", "unknown-reason", "step", "attempt", "id", "index", "phase", "timestamp", "semantics-prose"] as const;
/** Deliberate private queue mutations are not caller-owned input authorization. */
function corrupt(record: object, fault: typeof faults[number]): void {
  if (fault === "extra-prose") Object.assign(record, { prose: "unauthorized prose" });
  if (fault === "extra-capture") Object.assign(record, { observationId: "engine-data", capturedAt: "engine-time", viewport: { width: 1, height: 1 } });
  if (fault === "unknown-reason") Object.assign(Reflect.get(record, "image"), { reason: "unauthorized prose" });
  if (fault === "step") Object.assign(record, { stepId: "attempt:9" });
  if (fault === "attempt") Object.assign(record, { attemptId: "other-attempt" });
  if (fault === "id") Object.assign(record, { id: "other-boundary" });
  if (fault === "index") Object.assign(record, { stepIndex: 9 });
  if (fault === "phase") Object.assign(record, { phase: Reflect.get(record, "phase") === "before" ? "after" : "before" });
  if (fault === "timestamp") Object.assign(record, { attemptedAt: "2026-02-30T00:00:00.000Z" });
  if (fault === "semantics-prose") Object.assign(Reflect.get(record, "semantics"), { text: "unauthorized prose" });
}
/** Checks every first-write attempt/put with an independent exact protocol oracle. */
function assertProtocol(bytes: Uint8Array, source: DebugCheckpoint): void {
  const text = Buffer.from(bytes).toString("utf8"), value = JSON.parse(text);
  expect(text === JSON.stringify(value) || text === JSON.stringify(value) + "\n").toBe(true);
  expect(Object.keys(value).toSorted()).toEqual(Object.keys(minimal()).toSorted());
  for (const key of ["format", "id", "attemptId", "stepId", "stepIndex", "phase", "attemptedAt"] as const) expect(value[key]).toBe(source[key]);
  for (const key of ["semantics", "image"]) expect(value[key]).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
}
const rawFaults = ["duplicate-top", "duplicate-reason", "extra-LF", "trailing-space", "trailing-prose", "trailing-JSON"] as const;
/** JSON.parse discards earlier duplicate values; source-byte permission must not. */
function rawBytes(fault: typeof rawFaults[number]): Buffer {
  const text = JSON.stringify(minimal());
  if (fault === "duplicate-top") return Buffer.from('{"id":"discarded prose",' + text.slice(1));
  if (fault === "duplicate-reason") return Buffer.from(text.replace('"reason":"CAPTURE_UNAVAILABLE"', '"reason":"discarded prose","reason":"CAPTURE_UNAVAILABLE"'));
  return Buffer.from(text + (fault === "extra-LF" ? "\n\n" : fault === "trailing-space" ? " " : fault === "trailing-prose" ? "discarded prose" : "{}"));
}

it.each([true, false])("permits real opaque minimal facts before first write, store=%s", async (store) => {
  const h = setup("opaque", store); await h.capture(); const sources = h.collector.all(); await h.finish();
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
  expect(writes.all).toHaveLength(2); expect(h.puts).toHaveLength(store ? 2 : 0);
  for (const [index, row] of writes.all.entries()) assertProtocol(row.bytes, sources[index]!);
  for (const row of h.puts) { assertProtocol(row.bytes, sources.find((source) => source.phase === JSON.parse(Buffer.from(row.bytes).toString()).phase)!); expect(row.redaction).toBe("complete"); expect(row.sha256).toBe(sha(row.bytes)); }
});
it.each(faults.flatMap((fault) => [true, false].map((store) => ({ fault, store }))))("reconstructs opaque $fault using original boundary only, store=$store", async ({ fault, store }) => {
  const h = setup("opaque", store); await h.capture(); const sources = h.collector.all();
  const queue = Reflect.get(h.collector, "pending") as { record: DebugCheckpoint }[];
  for (const entry of queue) corrupt(entry.record, fault);
  await h.finish();
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
  expect(writes.all).toHaveLength(2); expect(h.puts).toHaveLength(store ? 2 : 0);
  for (const [index, row] of writes.all.entries()) assertProtocol(row.bytes, sources[index]!);
  for (const row of h.puts) assertProtocol(row.bytes, sources.find((source) => source.phase === JSON.parse(Buffer.from(row.bytes).toString()).phase)!);
});
it.each([...faults, ...rawFaults])("denies original matching receipt for %s BEFORE first write", (fault) => {
  const h = setup(), ticket = unavailableTicket(h), record = minimal();
  const raw = rawFaults.includes(fault as typeof rawFaults[number]);
  if (!raw) corrupt(record, fault as typeof faults[number]);
  const bytes = raw ? rawBytes(fault as typeof rawFaults[number]) : Buffer.from(JSON.stringify(record));
  bind(h.artifacts.sink, ticket, bytes);
  const allowed = proven(h.artifacts.sink, ticket, bytes);
  if (allowed) writeFileSync(path.join(h.artifacts.dir, "invalid.json"), bytes);
  console.log(JSON.stringify({ checkpointFinding: 10, seam: "original-same-sink", fault, allowed, firstFileAttempts: writes.all.length, ...h.counts() }));
  expect(allowed).toBe(false); expect(writes.all).toEqual([]); expect(existsSync(path.join(h.artifacts.dir, "invalid.json"))).toBe(false);
});
it.each([...faults, ...rawFaults].flatMap((fault) => [true, false].map((store) => ({ fault, store }))))("sink refuses matching invalid $fault even when prewrite guard is bypassed, store=$store", async ({ fault, store }) => {
  const h = setup("opaque", store), ticket = unavailableTicket(h), record = minimal();
  const raw = rawFaults.includes(fault as typeof rawFaults[number]);
  if (!raw) corrupt(record, fault as typeof faults[number]);
  const bytes = raw ? rawBytes(fault as typeof rawFaults[number]) : Buffer.from(JSON.stringify(record));
  bind(h.artifacts.sink, ticket, bytes); writeFileSync(path.join(h.artifacts.dir, "invalid.json"), bytes);
  const id = h.artifacts.sink.register("log", "invalid.json", ticket); await h.artifacts.settle();
  const row = h.artifacts.records.find((entry) => entry.id === id)!;
  expect(h.puts).toEqual([]); expect(row.redaction).toBe("incomplete"); expect(row.path).toBeUndefined(); expect(row.ref).toBeUndefined();
  expect(h.artifacts.debugRedactionProven(id)).toBe(false);
});
it.each(faults.flatMap((fault) => [true, false].map((store) => ({ fault, store }))))("collector rejects unavailable $fault before first write under proven content, store=$store", async ({ fault, store }) => {
  const h = setup("none", store, true); await h.capture();
  const queue = Reflect.get(h.collector, "pending") as { record: DebugCheckpoint }[];
  const source = h.collector.all();
  for (const entry of queue) corrupt(entry.record, fault);
  await h.finish(); expect(writes.all).toEqual([]); expect(h.puts).toEqual([]);
  for (const [index, record] of h.collector.all().entries()) assertProtocol(Buffer.from(JSON.stringify(record)), source[index]!);
});
it.each((["none", "literal", "env"] as const).flatMap((mode) => [true, false].map((store) => ({ mode, store }))))("preserves original owned PNG bytes and final masked JSON for $mode, store=$store", async ({ mode, store }) => {
  const h = setup(mode, store); await h.capture(); h.engineBytes.fill(0); await h.finish();
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 2 });
  expect(writes.all).toHaveLength(4); expect(h.puts).toHaveLength(store ? 4 : 0);
  for (const row of writes.all) {
    if (row.file.endsWith(".png")) expect(Buffer.from(row.bytes)).toEqual(png);
    else { const value = JSON.parse(Buffer.from(row.bytes).toString()); expect(value.stepId).toBe(h.step.id);
      expect(value.semantics.text).toContain(mode === "none" ? "protocol-secret-A51" : "<secret:token>"); }
  }
  for (const row of h.artifacts.records) { expect(row.redaction).toBe("complete"); expect(row.sha256).toBe(sha(readFileSync(path.join(h.artifacts.dir, row.path!)))); }
});
it.each([true, false].flatMap((lf) => [true, false].map((store) => ({ lf, store }))))("accepts original canonical fixed JSON, LF=$lf store=$store", async ({ lf, store }) => {
  const h = setup("opaque", store), ticket = unavailableTicket(h);
  const bytes = Buffer.from(JSON.stringify(minimal()) + (lf ? "\n" : ""));
  bind(h.artifacts.sink, ticket, bytes); expect(proven(h.artifacts.sink, ticket, bytes)).toBe(true);
  writeFileSync(path.join(h.artifacts.dir, "valid.json"), bytes);
  h.artifacts.sink.register("log", "valid.json", ticket); await h.artifacts.settle();
  expect(h.puts).toHaveLength(store ? 1 : 0); expect(h.artifacts.records[0]!.path).toBe("valid.json");
});

it.each((["missing", "copy", "spent", "cross-sink", "mutable", "rebind"] as const).flatMap((mode) => [true, false].map((store) => ({ mode, store }))))("denies $mode original pixel receipt BEFORE first PNG attempt, store=$store", async ({ mode, store }) => {
  const h = setup("none", store);
  if (mode === "missing") {
    const binder = custody.bindDebugEvidenceBytes;
    vi.spyOn(custody, "bindDebugEvidenceBytes").mockImplementation((sink, ticket, bytes) => {
      if (bytes.byteLength !== png.length) binder(sink, ticket, bytes);
    });
  }
  await h.capture();
  const queue = Reflect.get(h.collector, "pending") as { pixels: Uint8Array; pixelRegistration: ArtifactRegistration }[];
  for (const entry of queue) {
    if (mode === "copy") entry.pixelRegistration = { ...entry.pixelRegistration };
    if (mode === "cross-sink") {
      const other = setup("none", false);
      entry.pixelRegistration = custody.debugEvidenceRegistration(other.artifacts.sink);
      custody.bindDebugEvidenceBytes(other.artifacts.sink, entry.pixelRegistration, entry.pixels);
    }
    if (mode === "spent") h.artifacts.sink.register("screenshot", "absent-spent.png", entry.pixelRegistration);
    if (mode === "mutable") entry.pixels[8] = entry.pixels[8]! ^ 1;
    if (mode === "rebind") custody.bindDebugEvidenceBytes(h.artifacts.sink, entry.pixelRegistration, entry.pixels);
  }
  await h.finish();
  expect(writes.all.filter((row) => row.file.endsWith(".png"))).toEqual([]);
  expect(h.puts.filter((row) => row.kind === "screenshot")).toEqual([]);
  expect(h.puts.filter((row) => row.kind === "log")).toHaveLength(store ? 2 : 0);
  expect(h.collector.all().every((record) => record.image.status === "unavailable")).toBe(true);
});

it("binds owned pixel copies to the actual START tickets at capture, not at finish", async () => {
  const h = setup("none", true);
  const starts = vi.spyOn(custody, "debugEvidenceRegistration"), binds = vi.spyOn(custody, "bindDebugEvidenceBytes");
  const observe = vi.spyOn(h.session, "observe");
  await h.capture();
  expect(starts).toHaveBeenCalledTimes(2); expect(binds).toHaveBeenCalledTimes(2);
  for (const [index, args] of binds.mock.calls.entries()) {
    expect(args[1]).toBe(starts.mock.results[index]!.value);
    expect(starts.mock.invocationCallOrder[index]!).toBeLessThan(observe.mock.invocationCallOrder[index]!);
    expect(args[2]).not.toBe(h.engineBytes); expect(sha(args[2])).toBe(sha(png));
  }
  h.engineBytes.fill(0); await h.finish();
  expect(binds).toHaveBeenCalledTimes(4);
  for (const row of writes.all.filter((entry) => entry.file.endsWith(".png"))) expect(Buffer.from(row.bytes)).toEqual(png);
});

it.each([true, false])("mutable public facts cannot reauthorize an original SDK-facts ticket, store=%s", async (store) => {
  const h = setup("opaque", store), ticket = unavailableTicket(h), original = minimal();
  Object.assign(ticket, { stepId: "attempt:99", startedAt: "2026-01-02T00:00:00.000Z" });
  const bytes = Buffer.from(JSON.stringify(original)); bind(h.artifacts.sink, ticket, bytes);
  expect(proven(h.artifacts.sink, ticket, bytes)).toBe(true);
  writeFileSync(path.join(h.artifacts.dir, "original.json"), bytes);
  const id = h.artifacts.sink.register("log", "original.json", ticket);
  await h.artifacts.settle();
  expect(h.artifacts.records.find((row) => row.id === id)!.producer).toEqual({ kind: "step", stepId: "attempt:0" });
  expect(h.artifacts.records[0]!.startedAt).toBe(original.attemptedAt);
  expect(h.puts).toHaveLength(store ? 1 : 0);
});

it.each((["changed-bytes", "ledger-growth", "opaque", "failed-read"] as const).flatMap((mode) => [true, false].map((store) => ({ mode, store }))))("checks CP original bytes and live proof AFTER $mode async read, store=$store", async ({ mode, store }) => {
  const h = setup("none", store);
  const ticket = custody.associateDebugCheckpoint(custody.debugEvidenceRegistration(h.artifacts.sink, "checkpoint-json"),
    { checkpointId: "attempt:0:checkpoint:before", phase: "before", observationId: "attempt:rev", observationRevision: "rev" },
    { stepId: "attempt:0", startedAt: minimal().attemptedAt });
  const bytes = Buffer.from('{"safe":"redacted"}');
  custody.bindDebugEvidenceBytes(h.artifacts.sink, ticket, bytes);
  expect(custody.debugEvidenceBytesProven(h.artifacts.sink, ticket, bytes)).toBe(true);
  writeFileSync(path.join(h.artifacts.dir, "original.json"), bytes);
  io.afterRead = async (_file, read) => {
    if (mode === "changed-bytes") read[9] = read[9]! ^ 1;
    if (mode === "ledger-growth") h.secrecy.ledger.register("late", "later-secret");
    if (mode === "opaque") sessionSecrecy(h.session, new Map([["late", { name: "late", purpose: "generic-secret", value: () => { throw new Error("unused provider"); } }]]));
    if (mode === "failed-read") throw new Error("synthetic failed CP read");
  };
  h.artifacts.sink.register("log", "original.json", ticket);
  await h.artifacts.settle();
  expect(h.puts).toEqual([]);
  expect(h.artifacts.records[0]!.path).toBeUndefined(); expect(h.artifacts.records[0]!.redaction).toBe("incomplete");
  expect(h.counts()).toEqual({ providers: 0, getters: 0, observations: 0 });
});

it.each([true, false])("does not require CP byte binding for unrelated ordinary SDK/unticketed artifacts, store=%s", async (store) => {
  const h = setup("none", store);
  for (const [index, ticket] of [undefined, { debugEvidence: true }, custody.debugEvidenceRegistration(h.artifacts.sink)].entries()) {
    const file = `generic-${index}.png`; writeFileSync(path.join(h.artifacts.dir, file), png);
    h.artifacts.sink.register("screenshot", file, ticket);
  }
  await h.artifacts.settle();
  expect(h.puts).toHaveLength(store ? 3 : 0);
  expect(h.artifacts.records.every((row) => row.redaction === "complete" && row.path !== undefined)).toBe(true);
  expect(h.artifacts.debugCheckpoints.size).toBe(0);
});

it.each(["UNSUPPORTED_CAPABILITY", "CAPTURE_UNAVAILABLE", "CAPTURE_TIMEOUT", "CANCELLED", "EVIDENCE_LIMIT", "ARTIFACT_UNAVAILABLE"] as const)("accepts closed image reason %s without generic prose permission", (reason) => {
  const h = setup(), ticket = unavailableTicket(h), record = minimal();
  record.image.reason = reason;
  if (reason !== "ARTIFACT_UNAVAILABLE") record.semantics.reason = reason;
  const bytes = Buffer.from(JSON.stringify(record)); bind(h.artifacts.sink, ticket, bytes);
  expect(proven(h.artifacts.sink, ticket, bytes)).toBe(true);
});
