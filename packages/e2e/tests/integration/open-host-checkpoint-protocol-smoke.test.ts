/** Published entrypoints in a child process. Synthetic engine, no private imports or live provider. */
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { it, expect } from "vitest";

const exec = promisify(execFile);
/** Canonical unavailable facts must remain useful to an ordinary public SDK consumer. */
function smoke(cwd: string, store: boolean): string {
  return `
    import assert from "node:assert/strict";
    import { readFileSync, readdirSync } from "node:fs";
    import path from "node:path";
    import { openHost } from "e2e/runner";
    import { defineEngine, ENGINE_SPI_VERSION } from "e2e/engine";
    let providers = 0, observes = 0, opens = 0;
    const puts = [];
    const engine = defineEngine({
      name: "fixed-facts-smoke", version: "1.0.0", spiVersion: ENGINE_SPI_VERSION,
      session: { open: async () => { opens++; } },
      observe: async () => { observes++; throw new Error("opaque capture must not observe"); },
    });
    const host = await openHost({ cwd: ${JSON.stringify(cwd)}, env: {}, config: {
      targets: [{ name: "synthetic", platform: "synthetic", engine, app: { url: "https://synthetic.invalid" } }],
      secrets: { future: () => { providers++; return "future-secret"; } },
      ...(${store} ? { artifacts: { store: { put: async (artifact) => {
        puts.push({ ...artifact, bytes: Buffer.from(artifact.bytes) }); return { ref: artifact.sha256 };
      } } } } : {}),
    } });
    try {
      const session = await host.openSession({ name: "fixed facts consumer", debugCheckpoints: { retain: "on", pixels: true } });
      await session.fixtures.app.open();
      assert.deepEqual(await session.close(), []);
      const records = session.checkpoints(), step = session.steps()[0];
      assert.equal(records.length, 2);
      const files = readdirSync(path.join(session.artifactsDir, "debug"));
      assert.equal(files.length, 2); assert.ok(files.every((file) => file.endsWith(".json")));
      const check = (bytes) => {
        const text = Buffer.from(bytes).toString("utf8"), value = JSON.parse(text);
        assert.equal(text, JSON.stringify(value) + "\\n");
        assert.deepEqual(Object.keys(value).sort(), ["format","id","attemptId","stepId","stepIndex","phase","attemptedAt","semantics","image"].sort());
        assert.equal(value.format, "debug-checkpoint-1");
        assert.equal(value.stepId, step.id); assert.equal(value.stepId, value.attemptId + ":" + value.stepIndex);
        assert.equal(value.id, step.id + ":checkpoint:" + value.phase);
        assert.equal(new Date(value.attemptedAt).toISOString(), value.attemptedAt);
        assert.deepEqual(value.semantics, { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
        assert.deepEqual(value.image, { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
      };
      for (const file of files) check(readFileSync(path.join(session.artifactsDir, "debug", file)));
      assert.equal(puts.length, ${store ? 2 : 0});
      for (const put of puts) { check(put.bytes); assert.equal(put.redaction, "complete"); assert.equal(put.mediaType, "application/json"); assert.equal(put.stepId, step.id); }
      for (const record of records) assert.ok(step.artifacts.includes(record.artifactId));
      assert.equal(opens, 1); assert.equal(providers, 0); assert.equal(observes, 0);
      console.log(JSON.stringify({ store: ${store}, files: files.length, puts: puts.length, providers, observes, opens, canonical: true, stepArtifacts: step.artifacts.length }));
    } finally { assert.deepEqual(await host.close(), []); }
  `;
}
it.each([true, false])("published SDK retains canonical owned unavailable JSON, store=%s", async (store) => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "cp-fixed-public-"));
  try {
    const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "--eval", smoke(cwd, store)], { timeout: 30_000 });
    expect(stderr).toBe("");
    expect(JSON.parse(stdout.trim())).toEqual({ store, files: 2, puts: store ? 2 : 0, providers: 0, observes: 0, opens: 1, canonical: true, stepArtifacts: 2 });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
