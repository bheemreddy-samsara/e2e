/** Built SDK first-publication checks. Recovery/export integration belongs to the combined parent suite. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { DebugCheckpoint } from "../../src/runner.ts";
import { createFakeEngine } from "../helpers/fake-engine.ts";
import { hostHarness, secrets } from "../helpers/open-host.ts";

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/debug-checkpoint-v1.schema.json", import.meta.url), "utf8")));
const pixels = { data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: "image/png" as const, width: 1, height: 1, scale: 1 };

/** Checks only SDK facts remain, not text later repaired or a guessed capture identity. */
function withheld(records: readonly DebugCheckpoint[]): void {
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

describe("openHost: prospective checkpoint privacy", { timeout: 60_000 }, () => {
  const { host, config } = hostHarness();
  it.each([false, true].flatMap((alreadyResolved) => [false, true].map((disposeFails) => ({ alreadyResolved, disposeFails }))))(
    "withholds BEFORE first store with future disposal: %j", async ({ alreadyResolved, disposeFails }) => {
      const handle = secrets.get("future");
      let calls = 0, resolve!: () => Promise<string>, pixelCalls = 0;
      const firstBytes: string[] = [], callsAtStore: number[] = [];
      const fake = createFakeEngine({ secrets: [handle],
        tree: { ref: { id: "s", revision: "" }, role: "status", name: "X".repeat(253) + "abq" },
        onStartAttempt: async (context) => { resolve = () => context.resolveSecret(handle); if (alreadyResolved) await resolve(); },
        onDispose: async () => { await resolve(); if (disposeFails) throw new Error("future disposal failed"); },
        pixels: () => { pixelCalls++; return { pixels }; },
      });
      const opened = await host(fake.engine, { config: config(fake.engine, {
        secrets: { future: () => { calls++; return alreadyResolved && calls === 1 ? "first-safe-value" : "abqdef"; } },
        artifacts: { store: { put: async (artifact) => {
          if (artifact.path.endsWith(".json")) { callsAtStore.push(calls); firstBytes.push(Buffer.from(artifact.bytes).toString()); }
          return { ref: artifact.sha256 };
        } } },
      }) });
      const session = await opened.openSession({ name: "lateabqdef", debugCheckpoints: { retain: "on", pixels: true } });
      await session.fixtures.app.open();
      const active = session.checkpoints();
      expect(await session.close()).toEqual([]);
      const beforeDispose = session.checkpoints();
      const callsBeforeDispose = calls;
      const diskBeforeDispose = readdirSync(path.join(session.artifactsDir, "debug")).filter((file) => file.endsWith(".json")).map((file) => readFileSync(path.join(session.artifactsDir, "debug", file), "utf8"));
      const errors = await opened.close();
      expect(errors).toHaveLength(disposeFails ? 1 : 0);
      expect(callsBeforeDispose).toBe(alreadyResolved ? 1 : 0);
      expect(calls).toBe(alreadyResolved ? 2 : 1);
      expect(callsAtStore).toEqual([callsBeforeDispose, callsBeforeDispose]);
      expect(firstBytes).toHaveLength(2);
      for (const records of [firstBytes.map((bytes) => JSON.parse(bytes)), diskBeforeDispose.map((bytes) => JSON.parse(bytes)), active, beforeDispose, session.checkpoints()]) withheld(records);
      for (const bytes of [...firstBytes, ...diskBeforeDispose, JSON.stringify(session.checkpoints())]) {
        expect(bytes).not.toContain("abq"); expect(bytes).not.toContain("first-safe-value");
      }
      expect(pixelCalls).toBe(0);
      expect(readdirSync(path.join(session.artifactsDir, "debug")).every((file) => file.endsWith(".json"))).toBe(true);
    },
  );
  it.each(["none", "literal", "env override"])("keeps available evidence with %s and no effective opaque provider", async (mode) => {
    let calls = 0;
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, role: "status", name: "public abcdef" }, pixels: () => ({ pixels }) });
    const opened = await host(fake.engine, { env: mode === "env override" ? { E2E_SECRET_FUTURE: "abcdef" } : {}, config: config(fake.engine, mode === "none" ? {} : { secrets: { future: mode === "literal" ? "abcdef" : () => { calls++; return "unknown-value"; } } }) });
    const session = await opened.openSession({ name: "safe literals", debugCheckpoints: { retain: "on", pixels: true } });
    await session.fixtures.app.open(); await session.close();
    expect(calls).toBe(0);
    for (const record of session.checkpoints()) {
      expect(record.semantics.status).toBe("available"); expect(record.image.status).toBe("available");
      if (record.semantics.status === "available") expect(record.semantics.text).toContain(mode === "none" ? "abcdef" : "<secret:future>");
      expect(record.observationId).toBeDefined(); expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    }
  });
});
