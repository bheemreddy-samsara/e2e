/** Checkpoint publication is a privacy transaction over required cleanup, not real-device validation. */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../../src/index.ts";
import type { DebugCheckpoint } from "../../src/runner.ts";
import { createFakeEngine } from "../helpers/fake-engine.ts";
import { gate, hostHarness, secrets } from "../helpers/open-host.ts";

const pixels = { data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: "image/png" as const, width: 1, height: 1, scale: 1 };
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/debug-checkpoint-v1.schema.json", import.meta.url), "utf8")));

/** Missing evidence is explicit and carries no late-restorable plaintext or pixels. */
function expectWithheld(records: readonly DebugCheckpoint[]): void {
  expect(records).toHaveLength(2);
  for (const record of records) {
    expect(record.semantics).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
    expect(record.image).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
    expect(record.observationId).toBeUndefined();
    expect(record.capturedAt).toBeUndefined();
    expect(record.viewport).toBeUndefined();
    expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  }
}

describe("openHost: checkpoint privacy finalization", { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();

  it.each(["whole", "engine-cut"])("publishes first retained bytes only after retirement resolves a %s secret", async (form) => {
    // Equal-length nonhex content keeps the whole-JSON oracle disjoint from SDK UUIDs.
    const value = "abqdef";
    const observed = form === "whole" ? value : "X".repeat(253) + "abq";
    const handle = secrets.get("retiring");
    const provider = heldGate();
    const retiring = gate();
    const proceed = heldGate();
    let resolved!: Promise<string>;
    let debugWrittenBeforeDispose = false;
    let session!: Awaited<ReturnType<Awaited<ReturnType<typeof host>>["openSession"]>>;
    const firstPublications: string[] = [];
    const fake = createFakeEngine({ secrets: [handle], tree: { ref: { id: "s", revision: "" }, role: "status", name: observed },
      onStartAttempt: (context) => { resolved = context.resolveSecret(handle); },
      onEndAttempt: () => { throw new Error("retire this worker"); },
      onDispose: async () => {
        debugWrittenBeforeDispose = existsSync(path.join(session.artifactsDir, "debug"));
        retiring.resolve();
        await proceed.promise;
        provider.resolve();
        await resolved;
      }, pixels: () => ({ pixels }),
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { retiring: async () => { await provider.promise; return value; } },
      artifacts: { store: { put: async (artifact) => { if (artifact.path.endsWith(".json")) firstPublications.push(Buffer.from(artifact.bytes).toString()); return { ref: artifact.sha256 }; } } },
    }) });
    session = await opened.openSession({ name: "retirement proof", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    expectWithheld(session.checkpoints());
    const closing = session.close();
    await retiring.promise;
    await expect(opened.openSession({ name: "no premature reuse" })).rejects.toMatchObject({ code: "WORKER_PROTOCOL" });
    proceed.resolve();
    expect(await closing).toEqual([expect.objectContaining({ code: "ENGINE_FAILURE" })]);
    expect(debugWrittenBeforeDispose).toBe(false);
    expect(firstPublications).toHaveLength(2);
    for (const serialized of [...firstPublications, JSON.stringify(session.checkpoints())]) {
      expect(serialized).not.toContain(form === "whole" ? value : "abq");
      expect(serialized).toContain("CAPTURE_UNAVAILABLE");
    }
    for (const file of readdirSync(path.join(session.artifactsDir, "debug")).filter((candidate) => candidate.endsWith(".json"))) {
      const persisted = JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8"));
      expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
      expect(JSON.stringify(persisted)).not.toContain(form === "whole" ? value : "abq");
    }
  });

  it.each(["dispose timeout", "successful close with pending provider"])("fails closed permanently with %s", async (mode) => {
    const value = "checkpoint-unresolved-provider-941";
    const handle = secrets.get("pending");
    const provider = heldGate();
    let resolved!: Promise<string>;
    const puts: Parameters<ArtifactStore["put"]>[0][] = [];
    const fake = createFakeEngine({ secrets: [handle], tree: { ref: { id: "s", revision: "" }, role: "status", name: value },
      onStartAttempt: (context) => { resolved = context.resolveSecret(handle); },
      ...(mode === "dispose timeout" ? {
        onEndAttempt: () => { throw new Error("retire this worker"); },
        onDispose: async () => { await resolved; },
      } : {}), pixels: () => ({ pixels }),
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { cleanupTimeout: 40, secrets: { pending: async () => { await provider.promise; return value; } },
      artifacts: { store: { put: async (artifact) => { puts.push(artifact); return { ref: artifact.sha256 }; } } },
    }) });
    const session = await opened.openSession({ name: "pending proof", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    const started = Date.now();
    await session.close();
    expect(Date.now() - started).toBeLessThan(2000);
    expectWithheld(session.checkpoints());
    expect(puts.map(({ kind }) => kind)).toEqual(["log", "log"]);
    expect(puts.every(({ redaction }) => redaction === "complete")).toBe(true);
    for (const artifact of puts) {
      expect(artifact.path).not.toContain(value);
      const persisted = JSON.parse(Buffer.from(artifact.bytes).toString());
      expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
      expect(persisted.semantics).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
      expect(persisted.image).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
      expect(persisted.observationId).toBeUndefined();
      expect(persisted.capturedAt).toBeUndefined();
      expect(persisted.viewport).toBeUndefined();
      expect(artifact.startedAt).toBe(persisted.attemptedAt);
      expect(artifact.stepId).toBe(persisted.stepId);
      expect(artifact.attemptId).toBe(session.attemptId);
      expect(artifact.size).toBe(artifact.bytes.byteLength);
      expect(artifact.sha256).toBe(createHash("sha256").update(artifact.bytes).digest("hex"));
      expect(Buffer.from(artifact.bytes).toString()).not.toContain(value);
    }
    expect(readdirSync(path.join(session.artifactsDir, "debug")).every((file) => file.endsWith(".json"))).toBe(true);
    provider.resolve();
    await resolved;
    expectWithheld(session.checkpoints());
    for (const file of readdirSync(path.join(session.artifactsDir, "debug"))) expect(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).not.toContain(value);
  });

  it("rechecks fill taint before publishing images captured before a fill", async () => {
    const handle = secrets.get("fill");
    const fake = createFakeEngine({ pixels: () => ({ pixels }) });
    const puts: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { fill: "fill-provider-secret-812" },
      artifacts: { store: { put: async (artifact) => { puts.push(artifact.kind); return { ref: artifact.sha256 }; } } },
    }) });
    const session = await opened.openSession({ name: "tainted retention", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    await session.close();
    expect(session.checkpoints().every(({ image }) => image.status === "withheld" && image.reason === "PIXEL_TAINTED")).toBe(true);
    expect(puts).toEqual(["log", "log", "log", "log"]);
    expect(readdirSync(path.join(session.artifactsDir, "debug")).some((file) => file.endsWith(".png"))).toBe(false);
  });

  it("withholds permanently when timed-out cleanup could begin a provider after close", async () => {
    const value = "future-cleanup-secret-725";
    const handle = secrets.get("future");
    const continueCleanup = heldGate();
    const lateResolved = gate();
    let resolve!: () => Promise<string>;
    const fake = createFakeEngine({ secrets: [handle], tree: { ref: { id: "s", revision: "" }, role: "status", name: value },
      onStartAttempt: (context) => { resolve = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { await continueCleanup.promise; await resolve(); lateResolved.resolve(); },
      pixels: () => ({ pixels }),
    });
    let providerCalls = 0;
    const opened = await host(fake.engine, { config: config(fake.engine, { cleanupTimeout: 40,
      secrets: { future: () => { providerCalls++; return value; } },
    }) });
    const session = await opened.openSession({ name: "late cleanup", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    expect(await session.close()).toContainEqual(expect.objectContaining({ code: "CLEANUP_TIMEOUT" }));
    expect(providerCalls).toBe(0);
    expectWithheld(session.checkpoints());
    continueCleanup.resolve();
    await lateResolved.promise;
    expect(providerCalls).toBe(1);
    expectWithheld(session.checkpoints());
    for (const file of readdirSync(path.join(session.artifactsDir, "debug"))) expect(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).not.toContain(value);
  });

  it.each(["retirement", "host close"])("waits for required finish during %s without releasing the lease during artifact publication", async (mode) => {
    const value = "finish-provider-secret-626";
    const handle = secrets.get("finish");
    const provider = heldGate();
    const firstPut = gate();
    const releasePut = heldGate();
    let resolved!: Promise<string>;
    let session!: Awaited<ReturnType<Awaited<ReturnType<typeof host>>["openSession"]>>;
    let debugWrittenBeforeFinish = false;
    const fake = createFakeEngine({ secrets: [handle], tree: { ref: { id: "s", revision: "" }, role: "status", name: value },
      onStartAttempt: (context) => { resolved = context.resolveSecret(handle); },
      ...(mode === "retirement" ? { onEndAttempt: () => { throw new Error("retire this worker"); } } : {}),
    });
    const engine = { ...fake.engine, async prepare() { return undefined; }, async finish() {
      debugWrittenBeforeFinish = existsSync(path.join(session.artifactsDir, "debug"));
      provider.resolve();
      await resolved;
    } };
    const publications: string[] = [];
    const opened = await host(engine, { config: config(engine, { secrets: { finish: async () => { await provider.promise; return value; } },
      artifacts: { store: { put: async (artifact) => {
        publications.push(Buffer.from(artifact.bytes).toString());
        firstPut.resolve();
        await releasePut.promise;
        return { ref: artifact.sha256 };
      } } },
    }) });
    session = await opened.openSession({ name: "finish proof", debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    const closing = mode === "retirement" ? session.close() : opened.close();
    await firstPut.promise;
    const reuseConfig = { config: config(engine, { secrets: { finish: () => value } }) };
    let hostCloseSettled = false;
    const hostClosing = opened.close().then(() => { hostCloseSettled = true; });
    try {
      expect(debugWrittenBeforeFinish).toBe(false);
      await expect(host(engine, reuseConfig)).rejects.toMatchObject({ code: "WORKER_PROTOCOL" });
      await expect(opened.openSession({ name: "not idle" })).rejects.toMatchObject({ code: "WORKER_PROTOCOL" });
      expect(hostCloseSettled).toBe(false);
    } finally {
      releasePut.resolve();
      await closing;
      await hostClosing;
    }
    expect(publications).toHaveLength(2);
    expect(publications.join("\n")).not.toContain(value);
    expectWithheld(session.checkpoints());
    const replacement = await host(engine, reuseConfig);
    await opened.close();
    // Re-closing the old host must not release the replacement host's lease.
    await expect(host(engine, reuseConfig)).rejects.toMatchObject({ code: "WORKER_PROTOCOL" });
    await replacement.close();
  });

  it("does not invoke unused providers or retire a reusable worker to collect checkpoints", async () => {
    let calls = 0;
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { unused: () => { calls++; return "unused-provider-secret-885"; } } }) });
    for (let index = 0; index < 2; index++) {
      const session = await opened.openSession({ name: "reusable", debugCheckpoints: { retain: "on" } });
      await session.fixtures.app.open();
      expect(await session.close()).toEqual([]);
      expectWithheld(session.checkpoints());
    }
    expect(calls).toBe(0);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 2, attemptsEnded: 2, disposes: 0 });
  });

  it("never stores an image with unproven masking even after a complete ledger", async () => {
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, role: "textbox", name: "password", states: { secure: true } },
      pixels: () => ({ pixels, maskedRegionCount: 0 }),
    });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "unproven masking", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    await session.close();
    expect(session.checkpoints().every(({ image }) => image.status === "withheld" && image.reason === "MASKING_UNPROVEN")).toBe(true);
    expect(readdirSync(path.join(session.artifactsDir, "debug")).some((file) => file.endsWith(".png"))).toBe(false);
  });
});
