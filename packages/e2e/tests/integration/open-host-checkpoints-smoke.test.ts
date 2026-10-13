/** Public built SDK in an isolated subprocess with synthetic transport, no native device or model. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { hostHarness } from "../helpers/open-host.ts";

const exec = promisify(execFile);
const runner = new URL("../../dist/runner.js", import.meta.url).href;
const engine = new URL("../../dist/engine/index.js", import.meta.url).href;

/** The transport serializes observations and actions as a remote provider would. */
function smoke(cwd: string): string {
  return `
    import assert from "node:assert/strict";
    import { readFileSync, readdirSync } from "node:fs";
    import path from "node:path";
    import { openHost } from ${JSON.stringify(runner)};
    import { defineEngine, ENGINE_SPI_VERSION } from ${JSON.stringify(engine)};
    let screen = "start";
    const calls = [];
    const transport = async (method, payload = {}) => {
      calls.push(method);
      if (method === "open") screen = payload.url;
      return JSON.parse(JSON.stringify({ screen }));
    };
    const synthetic = defineEngine({
      name: "checkpoint-smoke", version: "1.0.0", spiVersion: ENGINE_SPI_VERSION,
      init: async () => { await transport("init"); },
      startAttempt: async () => { await transport("start"); },
      endAttempt: async () => { await transport("end"); },
      dispose: async () => { await transport("dispose"); },
      session: { open: async (url) => { await transport("open", { url }); } },
      observe: async () => {
        const response = await transport("observe");
        return { root: { ref: { id: "root", revision: "" }, role: "status", name: response.screen }, viewport: { width: 640, height: 480 } };
      },
    });
    const host = await openHost({ cwd: ${JSON.stringify(cwd)}, env: {}, config: { targets: [{ name: "synthetic", platform: "synthetic", engine: synthetic, app: { url: "https://synthetic.invalid" } }] } });
    const session = await host.openSession({ name: "subprocess checkpoint", debugCheckpoints: { retain: "on" } });
    try {
      await session.fixtures.app.open("/first");
      await session.fixtures.app.open("/second");
    } finally {
      assert.deepEqual(await session.close(), []);
      assert.deepEqual(await host.close(), []);
    }
    const checkpoints = session.checkpoints();
    assert.equal(checkpoints.length, 4);
    assert.match(checkpoints[0].semantics.text, /start/);
    assert.match(checkpoints[1].semantics.text, /first/);
    assert.match(checkpoints[2].semantics.text, /first/);
    assert.match(checkpoints[3].semantics.text, /second/);
    assert.equal(new Set(checkpoints.map((record) => record.observationId)).size, 4);
    for (const record of checkpoints) assert.ok(session.steps()[record.stepIndex].artifacts.includes(record.artifactId));
    const json = readdirSync(path.join(session.artifactsDir, "debug")).filter((file) => file.endsWith(".json"));
    assert.equal(json.length, 4);
    for (const file of json) assert.equal(JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).format, "debug-checkpoint-1");
    assert.equal(calls.filter((call) => call === "start").length, 1);
    assert.equal(calls.filter((call) => call === "end").length, 1);
    assert.equal(calls.filter((call) => call === "observe").length, 4);
    console.log(JSON.stringify({ steps: session.steps().length, checkpoints: checkpoints.length, artifacts: json.length, calls, modelCalls: session.steps().flatMap((step) => step.events).filter((event) => event.kind === "model").length }));
  `;
}

describe("host checkpoint subprocess smoke", () => {
  const { dir } = hostHarness();
  it("consumes built runner and engine entrypoints, preserving causal evidence and ownership", async () => {
    const { stdout, stderr } = await exec(process.execPath, ["--input-type=module", "--eval", smoke(dir())], { timeout: 30_000 });
    expect(stderr).toBe("");
    const evidence = JSON.parse(stdout.trim());
    expect(evidence).toMatchObject({ steps: 2, checkpoints: 4, artifacts: 4, modelCalls: 0 });
    expect(evidence.calls).toEqual(["init", "start", "observe", "open", "observe", "observe", "open", "observe", "end", "dispose"]);
  });
});
