/** Historical checkpoint selections must not outlive their value/text privacy dependencies. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { DebugCheckpoint } from "../../src/runner.ts";
import type { SemanticNode } from "../../src/engine/surface.ts";
import { createFakeEngine } from "../helpers/fake-engine.ts";
import { hostHarness, secrets } from "../helpers/open-host.ts";

const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/debug-checkpoint-v1.schema.json", import.meta.url), "utf8")));

/** Available checkpoint text only; missing evidence cannot be mistaken for a screen. */
function text(record: DebugCheckpoint): string {
  return record.semantics.status === "available" ? record.semantics.text : "";
}

const cases = ["whole", "engine-cut", "opaque", "multiple nodes", "elided dependency", "missing dependency", "content quota", "descriptor quota"] as const;
describe("openHost: historical selection privacy", { timeout: 60_000 }, () => {
  const { host, config } = hostHarness();

  it.each(["value", "text"].flatMap((field) => ["operation", "cleanup"].flatMap((during) =>
    cases.filter((form) => field === "text" || form !== "elided dependency").map((form) => ({ field, during, form })),
  )))("withholds dependent selections on reads and first publication: %j", async ({ field, during, form }) => {
    // Nonhex short tokens prevent false positives in SDK-generated UUIDs.
    const value = form === "opaque" ? "a\"bcde" : "abqdef";
    const selection = form === "opaque" ? "\"bc" : form === "engine-cut" ? "abq" : "bqd";
    const observed = form === "engine-cut" ? "X".repeat(509) + "abq" : value;
    const handle = secrets.get("late");
    const selected: SemanticNode = { ref: { id: form === "opaque" ? "odd\"id\\界😀" : "selected", revision: "" }, role: "textbox", selection, states: { focused: true },
      ...(form === "missing dependency" ? {} : { [field]: observed }),
      ...(form === "elided dependency" ? { name: observed } : {}),
    };
    const tree: SemanticNode = form === "multiple nodes" || form === "descriptor quota"
      ? { ref: { id: "root", revision: "" }, children: [
          ...(form === "descriptor quota" ? Array.from({ length: 2048 }, (_, index) => ({ ref: { id: `n${index}`, revision: "" }, name: "safe" }))
            : [{ ref: { id: "other", revision: "" }, role: "textbox", value: "public words", selection: "words" }]),
          selected,
        ] }
      : selected;
    let resolveAtClose!: () => Promise<string>;
    let providers = 0;
    const fake = createFakeEngine({ tree, secrets: [handle],
      onStartAttempt: (context) => { resolveAtClose = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { if (during === "cleanup") await resolveAtClose(); },
    });
    const firstBytes: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { late: () => { providers++; return value; } },
      artifacts: { store: { put: async (artifact) => {
        firstBytes.push(Buffer.from(artifact.bytes).toString());
        return { ref: artifact.sha256 };
      } } },
    }) });
    const maxBytes = form === "content quota" ? 30 : 128 * 1024;
    const session = await opened.openSession({ name: "historical selection", debugCheckpoints: { retain: "on", maxBytes } });
    await session.fixtures.app.open();
    const initial = session.checkpoints();
    expect(providers).toBe(0);
    if (during === "operation") await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    const live = session.checkpoints();
    expect(await session.close()).toEqual([]);
    expect(providers).toBe(1);
    const final = session.checkpoints();
    expect(final).toHaveLength(during === "operation" ? 4 : 2);
    expect(firstBytes).toHaveLength(final.length);
    const persisted = firstBytes.map((bytes) => JSON.parse(bytes) as DebugCheckpoint);
    // These are the first bytes handed to the store, not a later rewritten file.
    for (const record of persisted) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(text(record)).not.toContain(selection);
      expect(text(record)).not.toContain("selection=");
      expect(text(record)).not.toContain(value);
    }
    if (during === "operation") expect(live.map(text).join("\n")).not.toContain(selection);
    for (const records of [initial, live, final]) {
      for (const record of records) {
        expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
        expect(text(record)).not.toContain("selection=");
      }
      expect(records.reduce((total, record) => total + Buffer.byteLength(text(record)), 0)).toBeLessThanOrEqual(maxBytes);
    }
    expect(JSON.stringify(final)).not.toContain(selection);
    for (const record of [...initial, ...live, ...final, ...persisted]) {
      expect(record.semantics).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
      expect(record.observationId).toBeUndefined();
    }
    for (const file of readdirSync(path.join(session.artifactsDir, "debug"))) {
      expect(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).not.toContain(selection);
    }
  });

  it.each([false, true])("leaves ordinary executor observations unchanged with checkpoint opt-in=%s", async (enabled) => {
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, role: "textbox", value: "abcdef", selection: "bcd" } });
    let ordinary = "";
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: "off", agents: { default: { executor: {
      name: "selection-control", async runStep(context) {
        ordinary = (await context.observe()).text;
        return { status: "passed", summary: "observed" };
      },
    } } } }) });
    const session = await opened.openSession({ name: "default selection", ...(enabled ? { debugCheckpoints: { retain: "on" as const } } : {}) });
    await session.fixtures.agent.act("observe");
    expect(await session.close()).toEqual([]);
    expect(ordinary).toContain("value=\"abcdef\" selection=\"bcd\"");
    expect(session.checkpoints()).toHaveLength(enabled ? 2 : 0);
    expect(session.checkpoints().map(text).join("\n")).not.toContain("selection=");
  });
});
