/** Private first-write proof and historical scalar cuts; no sibling public APIs. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecretLedger } from "../../src/internal/redact.ts";
import type { SemanticNode, TargetSession } from "../../src/engine/surface.ts";
import type { ResolvedConfig } from "../../src/config/resolve.ts";
import { secretHandle } from "../../src/secrets.ts";
import { prospectiveSecretResolutionsProven, secretResolutionsProven, hasPendingSecretResolutions, sessionSecrecy, resolveSecretValue, trackSecretResolution, registerDerivedSecrets, SecretExposure } from "../../src/run/secrecy.ts";
import { associateDebugCheckpoint, createAttemptArtifacts, debugEvidenceRegistration } from "../../src/run/artifacts.ts";
import { DebugCheckpoints } from "../../src/run/debug-checkpoints.ts";
import { AttemptBudget } from "../../src/run/budget.ts";
import { Deadline } from "../../src/internal/time.ts";
import type { StepRecord } from "../../src/run/steps.ts";

const fault = vi.hoisted(() => ({ enabled: false, firstWrites: [] as string[],
  matches: (file: unknown) => String(file).replaceAll("\\", "/").endsWith("/debug/step-0-before.json"),
}));
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
    if (fault.enabled && fault.matches(args[0])) {
      const bytes = String(args[1]);
      fault.firstWrites.push(bytes);
      fs.writeFileSync(args[0], bytes.slice(0, Math.ceil(bytes.length / 2)));
      throw Object.assign(new Error("storage full"), { code: "ENOSPC" });
    }
    return fs.writeFileSync(...args);
  } };
});

describe("first-write fault paths", () => {
  it.each(["/tmp/attempt/debug/step-0-before.json", String.raw`C:\tmp\attempt\debug\step-0-before.json`])("matches %s", (file) => {
    expect(fault.matches(file)).toBe(true);
  });
  it.each(["/tmp/attempt/debug/step-0-after.json", String.raw`C:\tmp\attempt\debug\step-0-after.json`])("does not fault %s", (file) => {
    expect(fault.matches(file)).toBe(false);
  });
});

const dirs: string[] = [];
afterEach(() => { fault.enabled = false; fault.firstWrites.length = 0; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Effective map entries match the SDK resolved config, not the raw declaration layer. */
function configured(value: string | (() => string)): ResolvedConfig["allSecrets"] {
  return new Map([["token", { name: "token", purpose: "generic-secret", value }]]);
}

describe("prospective resolution accounting", () => {
  it("refuses missing configuration accounting even with an idle resolver queue", () => {
    const ledger = new SecretLedger();
    expect(secretResolutionsProven(ledger)).toBe(true);
    expect(prospectiveSecretResolutionsProven(ledger)).toBe(false);
  });
  it.each(["none", "literal"])("admits %s effective configuration without changing exposure", (mode) => {
    const secrecy = sessionSecrecy({} as TargetSession, mode === "literal" ? configured("abcdef") : new Map());
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(secrecy.exposure.withholdsPixels).toBe(false);
    if (mode === "literal") expect(secrecy.ledger.redact("abcdef")).toBe("<secret:token>");
  });
  it("distinguishes unused configured providers from actual pending calls and stays closed after fresh re-evaluation", async () => {
    let calls = 0;
    const config = configured(() => ++calls === 1 ? "old-safe-value" : "abcdef");
    const session = {} as TargetSession;
    const secrecy = sessionSecrecy(session, config);
    expect(hasPendingSecretResolutions(secrecy.ledger)).toBe(false);
    expect(secretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(0);
    const handle = secretHandle({ name: "token", purpose: "generic-secret" });
    expect(await resolveSecretValue(handle, config, secrecy.ledger)).toBe("old-safe-value");
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(await resolveSecretValue(handle, config, secrecy.ledger)).toBe("abcdef");
    expect(calls).toBe(2);
    expect(secretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    sessionSecrecy(session, new Map());
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
  });
  it("seeds another effective literal layer on a borrowed session before proving content", () => {
    const session = {} as TargetSession;
    const secrecy = sessionSecrecy(session, new Map());
    expect(sessionSecrecy(session, configured("abcdef"))).toBe(secrecy);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(true);
    expect(secrecy.ledger.redact("abcdef")).toBe("<secret:token>");
    expect(secrecy.exposure.withholdsPixels).toBe(false);
  });
  it("covers later effective provider/credential aliases without calling them", () => {
    let calls = 0;
    const session = {} as TargetSession;
    const secrecy = sessionSecrecy(session, new Map());
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(true);
    const aliases: ResolvedConfig["allSecrets"] = new Map([["admin.password", { name: "admin.password", purpose: "password", value: () => { calls++; return "abcdef"; } }]]);
    expect(sessionSecrecy(session, aliases)).toBe(secrecy);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(calls).toBe(0);
  });
  it("does not evaluate a later accessor-backed lazy value to establish proof", () => {
    let gets = 0;
    const session = {} as TargetSession;
    const secrecy = sessionSecrecy(session, new Map());
    const lazy = { name: "token", purpose: "generic-secret" as const, get value() { gets++; return "abcdef"; } };
    sessionSecrecy(session, new Map([["token", lazy]]));
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    expect(gets).toBe(0);
  });
  it("separates transient actual handoff work from permanently opaque configuration", async () => {
    const secrecy = sessionSecrecy({} as TargetSession, new Map());
    let release!: () => void;
    const pending = trackSecretResolution(secrecy.ledger, () => new Promise<void>((done) => { release = done; }));
    expect(hasPendingSecretResolutions(secrecy.ledger)).toBe(true);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
    release(); await pending;
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(true);
    await trackSecretResolution(secrecy.ledger, async () => { throw new Error("handoff failed"); }).catch(() => undefined);
    expect(prospectiveSecretResolutionsProven(secrecy.ledger)).toBe(false);
  });
});

describe("prospective artifact tickets", () => {
  it.each(["pixels", "checkpoint-json"] as const)("refuses %s proof for an unused configured provider", (kind) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "checkpoint-proof-")); dirs.push(dir);
    const secrecy = sessionSecrecy({} as TargetSession, configured(() => "abcdef"));
    const artifacts = createAttemptArtifacts({ artifactsRoot: dir, segments: [], attemptId: "attempt", secrecy: () => secrecy });
    const registration = associateDebugCheckpoint(debugEvidenceRegistration(artifacts.sink, kind),
      { checkpointId: "checkpoint", phase: "before", observationId: "observation", observationRevision: "revision" }, {});
    const id = artifacts.sink.register(kind === "pixels" ? "screenshot" : "log", kind === "pixels" ? "test.png" : "test.json", registration);
    expect(artifacts.debugRedactionProven(id)).toBe(false);
  });
  it.each(["valid", "capture association", "missing secrecy", "unconfigured secrecy", "copied", "reused"] as const)("restricts missing-evidence tickets: %s", (mode) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "checkpoint-missing-")); dirs.push(dir);
    const secrecy = mode === "unconfigured secrecy" ? { ledger: new SecretLedger(), exposure: new SecretExposure() }
      : sessionSecrecy({} as TargetSession, configured(() => "abcdef"));
    const artifacts = createAttemptArtifacts({ artifactsRoot: dir, segments: [], attemptId: "attempt", ...(mode === "missing secrecy" ? {} : { secrecy: () => secrecy }) });
    const registration = associateDebugCheckpoint(debugEvidenceRegistration(artifacts.sink, "checkpoint-unavailable"),
      { checkpointId: "checkpoint", phase: "before", observationId: mode === "capture association" ? "capture" : null, observationRevision: mode === "capture association" ? "revision" : null }, {});
    if (mode === "reused") artifacts.sink.register("log", "original.json", registration);
    const id = artifacts.sink.register("log", "missing.json", mode === "copied" ? { ...registration } : registration);
    expect(artifacts.debugRedactionProven(id)).toBe(mode === "valid");
  });
});

describe("first checkpoint write fault with a future SDK resolver", () => {
  it.each([false, true])("leaves only safe protocol bytes even if later resolution fails=%s", async (fails) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "checkpoint-enospc-")); dirs.push(dir);
    let calls = 0, observations = 0;
    const config = configured(() => { calls++; if (fails) throw new Error("future provider failure"); return "abcdef"; });
    const secrecy = sessionSecrecy({} as TargetSession, config);
    const handle = secretHandle({ name: "token", purpose: "generic-secret" });
    // Same SDK resolver a fixture/engine can retain until future recovery or disposal.
    const futureDispose = () => resolveSecretValue(handle, config, secrecy.ledger);
    const stored: string[] = [];
    const artifacts = createAttemptArtifacts({ artifactsRoot: dir, segments: [], attemptId: "attempt", secrecy: () => secrecy,
      store: { put: async (artifact) => { stored.push(Buffer.from(artifact.bytes).toString()); return { ref: artifact.sha256 }; } } });
    const session = { observe: async () => { observations++; throw new Error("must not request unproven content"); } } as unknown as TargetSession;
    const collector = new DebugCheckpoints({ policy: { retain: "on", pixels: true }, session, secrecy, artifacts: artifacts.sink,
      budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)), runId: "run", attemptId: "attempt", maxObservationBytes: 65536, appOrigin: undefined, onDeadline: () => undefined });
    await collector.run({ id: "attempt:0", index: 0, artifacts: [] } as unknown as StepRecord, async () => undefined);
    fault.enabled = true;
    await collector.finish(false, true); await artifacts.settle();
    expect(calls).toBe(0); expect(observations).toBe(0); expect(hasPendingSecretResolutions(secrecy.ledger)).toBe(false);
    expect(fault.firstWrites).toHaveLength(1); expect(stored).toHaveLength(1);
    const leftover = readFileSync(path.join(dir, "debug/step-0-before.json"), "utf8");
    expect(leftover).toBe(fault.firstWrites[0]!.slice(0, Math.ceil(fault.firstWrites[0]!.length / 2)));
    expect(fault.firstWrites[0]).toContain("CAPTURE_UNAVAILABLE");
    if (fails) await expect(futureDispose()).rejects.toThrow("future provider failure");
    else await expect(futureDispose()).resolves.toBe("abcdef");
    expect(calls).toBe(1);
    for (const bytes of [...fault.firstWrites, leftover, ...stored, JSON.stringify(collector.all())]) expect(bytes).not.toContain("abc");
    expect(collector.all().every(({ semantics, image, observationId }) => semantics.status === "unavailable" && image.status === "unavailable" && observationId === undefined)).toBe(true);
    expect(readFileSync(path.join(dir, "debug/step-0-before.json"), "utf8")).toBe(leftover);
  });
});

describe("historical scalar redaction with known effective configuration", () => {
  const cases = [
    { field: "name", tree: { ref: { id: "s", revision: "" }, name: "X".repeat(253) + "abc" }, value: "abcdef" },
    { field: "name quoted ID", tree: { ref: { id: 'odd"id', revision: "" }, name: 'a"bcde' }, value: 'a"bcde', maxBytes: 13 },
    { field: "role", tree: { ref: { id: 'odd"id', revision: "" }, role: 'a"bcde' }, value: 'a"bcde', maxBytes: 11 },
    { field: "value", tree: { ref: { id: "s", revision: "" }, role: "textbox", value: "X".repeat(509) + "abc", selection: "bcd" }, value: "abcdef" },
    { field: "collapsed text", tree: { ref: { id: "s", revision: "" }, text: "X  ".repeat(169) + "XXabc" }, value: "abcdef" },
    { field: "href", tree: { ref: { id: 'odd"id', revision: "" }, role: "link", attributes: { href: "https://app.invalid/" + "X".repeat(234) + "abcdef" } }, value: "abcdef" },
  ];
  it.each(cases)("redacts late SDK-derived cuts BEFORE the first file/store: $field", async ({ tree, value, ...entry }) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "checkpoint-cuts-")); dirs.push(dir);
    const secrecy = sessionSecrecy({} as TargetSession, new Map());
    const firstBytes: string[] = [];
    const artifacts = createAttemptArtifacts({ artifactsRoot: dir, segments: [], attemptId: "attempt", secrecy: () => secrecy,
      store: { put: async (artifact) => { firstBytes.push(Buffer.from(artifact.bytes).toString()); return { ref: artifact.sha256 }; } } });
    const session = { observe: async () => ({ kind: "semantic", tree: tree as SemanticNode, root: tree.ref, revision: "rev", capturedAt: new Date().toISOString(), viewport: { width: 1, height: 1 }, truncated: false, redaction: { secureNodeCount: 0, maskedRegionCount: 0 } }) } as unknown as TargetSession;
    const collector = new DebugCheckpoints({ policy: { retain: "on", ...("maxBytes" in entry ? { maxBytes: entry.maxBytes } : {}) }, session, secrecy,
      artifacts: artifacts.sink, budget: new AttemptBudget(new AbortController().signal, new Deadline(10_000)), runId: "run", attemptId: "attempt", maxObservationBytes: 65536, appOrigin: undefined, onDeadline: () => undefined });
    const step = { id: "attempt:0", index: 0, artifacts: [] } as unknown as StepRecord;
    await collector.run(step, async () => undefined);
    expect(collector.all()[0]!.semantics.status).toBe("available");
    registerDerivedSecrets("derived", [value], secrecy.ledger);
    await collector.finish(false, true); await artifacts.settle();
    expect(firstBytes).toHaveLength(2);
    expect(collector.all()[0]!.semantics.status).toBe("available");
    for (const record of collector.all()) {
      if (record.semantics.status === "unavailable") {
        expect(record.semantics.reason).toBe("EVIDENCE_LIMIT");
        continue;
      }
      if (record.semantics.status === "available") {
        expect(record.semantics.text).not.toContain(value);
        expect(record.semantics.text).not.toContain("abc");
        expect(record.semantics.text).not.toContain('a\\"b');
        expect(record.semantics.text).not.toContain("selection=");
      }
      expect(record.observationId).toBeDefined();
    }
    for (const bytes of [...firstBytes, readFileSync(path.join(dir, "debug/step-0-before.json"), "utf8")]) expect(bytes).not.toContain("abc");
  });
});
