/** Built hosted SDK checkpoints over a synthetic engine, not real-device validation. */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import type { DebugCheckpoint, DebugCheckpointPolicy } from "../../src/runner.ts";
import { createFakeEngine } from "../helpers/fake-engine.ts";
import { gate, hostHarness, sdkExpect, secrets } from "../helpers/open-host.ts";

const pixels = { data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: "image/png" as const, width: 1, height: 1, scale: 1 };
const ajv = new Ajv2020({ strict: false });
addFormats.default(ajv);
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../../schema/debug-checkpoint-v1.schema.json", import.meta.url), "utf8")));

/** Text only when the capture actually had semantics. */
function text(record: DebugCheckpoint): string {
  return record.semantics.status === "available" ? record.semantics.text : record.semantics.reason;
}

describe("openHost: debug checkpoints", { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();

  it("does no extra observations, pixels, artifacts or model work by default", async () => {
    let pixelCalls = 0;
    const fake = createFakeEngine({ pixels: () => { pixelCalls++; return { pixels }; } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "default" });
    await session.fixtures.app.open();
    await session.fixtures.screen.getByRole("button", "Submit").click();
    expect(fake.operations.filter(({ method }) => method === "observe")).toHaveLength(0);
    expect(pixelCalls).toBe(0);
    expect(session.checkpoints()).toEqual([]);
    expect(session.steps().flatMap(({ events }) => events).filter(({ kind }) => kind === "model")).toHaveLength(0);
    expect(await session.close()).toEqual([]);
    expect(existsSync(path.join(session.artifactsDir, "debug"))).toBe(false);
  });

  it("awaits before/after capture at consecutive action boundaries and stores original step associations", async () => {
    const tree = { ref: { id: "s", revision: "" }, role: "status", name: "screen-0" };
    const secondCapture = heldGate();
    const capturing = gate();
    let observations = 0;
    let changes = 0;
    let pixelCalls = 0;
    const fake = createFakeEngine({ tree,
      onNavigate: () => { tree.name = `screen-${++changes}`; },
      observe: async () => { if (++observations === 2) { capturing.resolve(); await secondCapture.promise; } },
      pixels: () => { pixelCalls++; return { pixels }; },
    });
    const puts: { stepId?: string; kind: string; redaction: string }[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, { artifacts: { store: { put: async (artifact) => { puts.push(artifact); return { ref: artifact.sha256 }; } } } }) });
    const session = await opened.openSession({ name: "screens", debugCheckpoints: { pixels: true, retain: "on" } });
    const first = session.fixtures.app.open("/one");
    await capturing.promise;
    const second = session.fixtures.app.open("/two");
    expect(changes).toBe(1);
    secondCapture.resolve();
    await Promise.all([first, second]);
    expect(session.checkpoints().map(text)).toEqual([expect.stringContaining("screen-0"), expect.stringContaining("screen-1"), expect.stringContaining("screen-1"), expect.stringContaining("screen-2")]);
    expect(session.checkpoints().map(({ phase }) => phase)).toEqual(["before", "after", "before", "after"]);
    expect(pixelCalls).toBe(4);
    expect(await session.close()).toEqual([]);
    const records = session.checkpoints();
    expect(new Set(records.map(({ id }) => id)).size).toBe(4);
    expect(new Set(records.map(({ observationId }) => observationId)).size).toBe(4);
    for (const record of records) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(Date.parse(record.capturedAt!)).toBeGreaterThanOrEqual(Date.parse(record.attemptedAt));
      expect(session.steps()[record.stepIndex]?.id).toBe(record.stepId);
      expect(session.steps()[record.stepIndex]?.artifacts).toContain(record.artifactId);
      expect(record.image.status).toBe("available");
    }
    expect(puts).toHaveLength(8);
    expect(puts.every(({ redaction }) => redaction === "complete")).toBe(true);
    expect(puts.map(({ stepId }) => stepId).toSorted()).toEqual(records.flatMap(({ stepId }) => [stepId, stepId]).toSorted());
    const jsonFiles = readdirSync(path.join(session.artifactsDir, "debug")).filter((file) => file.endsWith(".json"));
    for (const file of jsonFiles) expect(validate(JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")))).toBe(true);
    expect(await session.close()).toEqual([]);
    expect(puts).toHaveLength(8);
  });

  it("keeps capture independent from a custom executor and leaves model metrics unchanged", async () => {
    let executorCalls = 0;
    let pixelCalls = 0;
    const fake = createFakeEngine({ pixels: () => { pixelCalls++; return { pixels }; } });
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: "off", agents: { default: { executor: {
      name: "synthetic", async runStep(context) {
        executorCalls++;
        const observation = await context.observe();
        expect(observation.pixels).toBeUndefined();
        await context.actions.navigate("/next");
        return { status: "passed", summary: "navigated" };
      },
    } } } }) });
    const session = await opened.openSession({ name: "no model", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.agent.act("navigate");
    expect(executorCalls).toBe(1);
    expect(pixelCalls).toBe(2);
    expect(session.checkpoints()).toHaveLength(2);
    expect(session.steps()[0]?.metrics?.modelCalls).toBe(0);
    expect(session.steps()[0]?.visionInput).toBeUndefined();
    expect(await session.close()).toEqual([]);
  });

  it("does not deadlock or claim separate evidence for nested fixture calls", async () => {
    const fake = createFakeEngine();
    const engine = { ...fake.engine, fixtures: { gadget: (context: import("../../src/engine/index.ts").EngineFixtureContext) => context.fixture("gadget", {
      poke: async () => { await session.fixtures.app.open(); return "nested"; },
    }, { poke: { kind: "resource" as const } }) } };
    const opened = await host(engine);
    const session = await opened.openSession({ name: "nested", debugCheckpoints: { retain: "on" } });
    expect(await session.fixtures.gadget.poke("nested")).toBe("nested");
    expect(session.steps().map(({ api }) => api)).toEqual(["gadget.poke", "app.open"]);
    expect(session.checkpoints().map(({ stepIndex }) => stepIndex)).toEqual([0, 0]);
    await session.close();
    expect(session.steps()[0]?.artifacts).toHaveLength(2);
    expect(session.steps()[1]?.artifacts).toHaveLength(0);
  });

  it("redacts secret fills and never requests post-fill pixels", async () => {
    const value = "checkpoint-secret-72";
    const handle = secrets.get("token");
    const tree = { ref: { id: "s", revision: "" }, role: "status", name: "not filled" };
    let pixelCalls = 0;
    const fake = createFakeEngine({ tree, perform: () => { tree.name = value; }, pixels: () => { pixelCalls++; return { pixels }; } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { token: value } }) });
    const session = await opened.openSession({ name: "secret", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    await session.fixtures.app.open();
    expect(pixelCalls).toBe(1);
    expect(session.checkpoints().slice(1).map(({ image }) => image)).toEqual(Array.from({ length: 3 }, () => ({ status: "withheld", reason: "PIXEL_TAINTED" })));
    expect(JSON.stringify(session.checkpoints())).not.toContain(value);
    expect(session.checkpoints().map(text).join("\n")).toContain("<secret:token>");
    expect(await session.close()).toEqual([]);
    for (const file of readdirSync(path.join(session.artifactsDir, "debug"))) expect(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).not.toContain(value);
  });

  it("withholds provider-backed engine-cut fragments before reads and persistence", async () => {
    const value = "provider-secret-" + "Q".repeat(300);
    const handle = secrets.get("late");
    const tree = { ref: { id: "s", revision: "" }, role: "status", name: value.slice(0, 256) };
    const fake = createFakeEngine({ tree });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => value } }) });
    const session = await opened.openSession({ name: "late redaction", debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    expect(JSON.stringify(session.checkpoints())).not.toContain(value.slice(0, 256));
    expect(session.checkpoints().every(({ semantics }) => semantics.status === "unavailable" && semantics.reason === "CAPTURE_UNAVAILABLE")).toBe(true);
    await session.close();
    for (const file of readdirSync(path.join(session.artifactsDir, "debug"))) expect(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8")).not.toContain(value.slice(0, 256));
  });

  it.each(["name", "text", "value", "selection", "placeholder"].flatMap((field) =>
    ["operation", "cleanup"].flatMap((resolvedDuring) => [false, true].map((fallback) => ({ field, resolvedDuring, fallback }))),
  ))("withholds bounded provider-backed fields before and after resolution: %j", async ({ field, resolvedDuring, fallback }) => {
    const value = "abcdef";
    const handle = secrets.get("lateShort");
    // Attributes have no engine cut contract: the placeholder exercises whole-value redaction.
    const suffix = field === "placeholder" ? value : "abc";
    const limit = field === "name" || field === "placeholder" ? 256 : 512;
    const observed = "X".repeat(limit - suffix.length) + suffix;
    const tree = { ref: { id: "s", revision: "" }, role: "textbox", ...(
      field === "placeholder" ? { attributes: { placeholder: observed } } : { [field]: observed }
    ) };
    let resolveAtClose: (() => Promise<string>) | undefined;
    const fake = createFakeEngine({ tree, secrets: [handle],
      onStartAttempt: (context) => { resolveAtClose = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { if (resolvedDuring === "cleanup") await resolveAtClose!(); },
      pixels: () => ({ pixels }),
    });
    let captures = 0;
    const engine = { ...fake.engine, observe: async (...args: Parameters<NonNullable<typeof fake.engine.observe>>) => ({
      ...await fake.engine.observe!(...args),
      ...(fallback && ++captures > 1 && args[1]?.pixelFallback === true ? { treeUnavailable: true as const } : {}),
    }) };
    const opened = await host(engine, { config: config(engine, { secrets: { lateShort: () => value } }) });
    const session = await opened.openSession({ name: "short late field", debugCheckpoints: { pixels: true, retain: "on", maxBytes: 4096 } });
    await session.fixtures.app.open();
    const first = session.checkpoints()[0]!;
    expect(first.semantics).toEqual({ status: "unavailable", reason: "CAPTURE_UNAVAILABLE" });
    if (resolvedDuring === "operation") {
      await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
      expect(text(session.checkpoints()[0]!)).not.toContain(suffix);
      expect(session.checkpoints()[0]!.semantics.status).toBe("unavailable");
    }
    expect(await session.close()).toEqual([]);
    const records = session.checkpoints();
    expect(text(records[0]!)).not.toContain(suffix);
    expect(records.every(({ semantics }) => semantics.status === "unavailable" && semantics.reason === "CAPTURE_UNAVAILABLE")).toBe(true);
    expect(records[0]!.observationId).toBe(first.observationId);
    expect(records[0]!.capturedAt).toBe(first.capturedAt);
    for (const record of records) expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
    const files = readdirSync(path.join(session.artifactsDir, "debug"));
    for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
      const persisted = JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8"));
      expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
      if (persisted.semantics.status === "available") expect(persisted.semantics.text).not.toContain(suffix);
    }
    const imageBytes = files.filter((file) => file.endsWith(".png")).reduce((total, file) => total + readFileSync(path.join(session.artifactsDir, "debug", file)).byteLength, 0);
    expect(imageBytes + records.reduce((total, record) => total + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(4096);
  });

  it.each(["opaque\"id", "s"])("withholds provider-backed engine-cut fields despite opaque quotes: %s", async (id) => {
    const handle = secrets.get("late");
    const name = "X".repeat(253) + "abc";
    const fake = createFakeEngine({ tree: { ref: { id, revision: "" }, role: "opaque\"role", name } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => "abcdef" } }) });
    const session = await opened.openSession({ name: "quoted identity", debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    const original = text(session.checkpoints()[0]!);
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    const redacted = text(session.checkpoints()[0]!);
    expect(redacted).not.toContain("abc");
    expect(redacted).toBe("CAPTURE_UNAVAILABLE");
    expect(original).toBe("CAPTURE_UNAVAILABLE");
    await session.close();
    expect(text(session.checkpoints()[0]!)).toBe(redacted);
  });

  it.each(["plain", "\"\\\ud800"])("withholds provider-backed prefixes regardless of content-quota cuts: %j", async (prefix) => {
    const handle = secrets.get("late");
    const name = prefix + "abcdef";
    const clipped = `#s ${JSON.stringify(prefix + "abc").slice(0, -1)}`;
    const maxBytes = Buffer.byteLength(clipped);
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, name } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => "abcdef" } }) });
    const session = await opened.openSession({ name: "quota-cut encoding", debugCheckpoints: { retain: "on", maxBytes } });
    await session.fixtures.app.open();
    expect(text(session.checkpoints()[0]!)).toBe("CAPTURE_UNAVAILABLE");
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    const beforeClose = session.checkpoints();
    expect(text(beforeClose[0]!)).not.toContain("abc");
    await session.close();
    expect(session.checkpoints().map(text)).toEqual(beforeClose.map(text));
    expect(session.checkpoints().reduce((bytes, record) => bytes + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(maxBytes);
  });

  it.each(["operation", "cleanup"].flatMap((resolvedDuring) =>
    ["name", "text", "value", "selection", "testId", "placeholder", "role"].flatMap((field) =>
      [false, true].map((multibyte) => ({ resolvedDuring, field, multibyte }))),
  ))("withholds provider-backed scalars at quoted-ID quota boundaries: %j", async ({ resolvedDuring, field, multibyte }) => {
    const value = multibyte ? "界😀bcde" : "a\"bcde";
    const prefix = multibyte ? "界😀b" : "a\"b";
    const handle = secrets.get("late");
    const id = "odd\"id";
    const observed = field === "placeholder" ? { attributes: { placeholder: value } } : { [field]: value };
    const token = field === "name" || field === "role" ? "" : `${field === "testId" ? "testid" : field}=`;
    const clipped = `#${id} ${token}${field === "role" ? prefix : JSON.stringify(prefix).slice(0, -1)}`;
    const maxBytes = Buffer.byteLength(clipped);
    let resolveAtClose: (() => Promise<string>) | undefined;
    const fake = createFakeEngine({ tree: { ref: { id, revision: "" }, ...observed }, secrets: [handle],
      onStartAttempt: (context) => { resolveAtClose = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { if (resolvedDuring === "cleanup") await resolveAtClose!(); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => value } }) });
    const session = await opened.openSession({ name: "formatter quota provenance", debugCheckpoints: { retain: "on", maxBytes } });
    await session.fixtures.app.open();
    expect(text(session.checkpoints()[0]!)).toBe("CAPTURE_UNAVAILABLE");
    if (resolvedDuring === "operation") {
      await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
      expect(text(session.checkpoints()[0]!)).not.toContain(field === "role" ? prefix : JSON.stringify(prefix).slice(1, -1));
    }
    expect(await session.close()).toEqual([]);
    const records = session.checkpoints();
    expect(text(records[0]!)).not.toContain(field === "role" ? prefix : JSON.stringify(prefix).slice(1, -1));
    expect(records.reduce((total, record) => total + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(maxBytes);
    for (const file of readdirSync(path.join(session.artifactsDir, "debug")).filter((candidate) => candidate.endsWith(".json"))) {
      const persisted = JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8"));
      expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
      if (persisted.semantics.status === "available") expect(persisted.semantics.text).not.toContain(field === "role" ? prefix : JSON.stringify(prefix).slice(1, -1));
    }
  });

  it.each(["operation", "cleanup"].flatMap((resolvedDuring) => [false, true].flatMap((sameOrigin) =>
    ["abcdef", "a\"bcde", "界😀bcde"].map((value) => ({ resolvedDuring, sameOrigin, value })),
  )))(
    "withholds provider-backed href cuts before their ellipsis: %j", async ({ resolvedDuring, sameOrigin, value }) => {
      const handle = secrets.get("late");
      const origin = "https://app.invalid";
      const leading = sameOrigin ? "/" : `${origin}/`;
      const prefix = value === "界😀bcde" ? "界😀b" : value.slice(0, 3);
      const href = (sameOrigin ? origin : "") + leading + "X".repeat(256 - leading.length - prefix.length) + value;
      const encodedPrefix = JSON.stringify(prefix).slice(1, -1);
      let resolveAtClose: (() => Promise<string>) | undefined;
      const fake = createFakeEngine({ tree: { ref: { id: "odd\"id", revision: "" }, role: "link", attributes: { href } }, secrets: [handle],
        onStartAttempt: (context) => { resolveAtClose = () => context.resolveSecret(handle); },
        onEndAttempt: async () => { if (resolvedDuring === "cleanup") await resolveAtClose!(); },
      });
      const base = config(fake.engine);
      const opened = await host(fake.engine, { config: { ...base, targets: [{ ...base.targets[0]!, app: { url: sameOrigin ? origin : "https://other.invalid" } }], secrets: { late: () => value } } });
      const session = await opened.openSession({ name: "formatter href provenance", debugCheckpoints: { retain: "on" } });
      await session.fixtures.app.open();
      expect(text(session.checkpoints()[0]!)).toBe("CAPTURE_UNAVAILABLE");
      if (resolvedDuring === "operation") {
        await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
        expect(text(session.checkpoints()[0]!)).not.toContain(encodedPrefix);
      }
      expect(await session.close()).toEqual([]);
      expect(session.checkpoints().map(text).join("\n")).not.toContain(encodedPrefix);
      for (const file of readdirSync(path.join(session.artifactsDir, "debug")).filter((candidate) => candidate.endsWith(".json"))) {
        const persisted = JSON.parse(readFileSync(path.join(session.artifactsDir, "debug", file), "utf8"));
        expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
        if (persisted.semantics.status === "available") expect(persisted.semantics.text).not.toContain(encodedPrefix);
      }
    },
  );

  it.each(["operation", "cleanup"].flatMap((resolvedDuring) => [
    { value: "abc\\de", extra: "\\" },
    { value: "abc\"de", extra: "\\" },
    { value: "abc\u0001de", extra: "\\u00" },
    { value: "abc界de", extra: "界", spareByte: 1 },
    { value: "abcd😀e", extra: "😀", spareByte: 2 },
  ].map((entry) => ({ resolvedDuring, ...entry }))))("withholds provider-backed incomplete units at a real quota boundary: %j", async ({ resolvedDuring, value, extra, ...entry }) => {
    const handle = secrets.get("late");
    const clipped = '#odd"id "' + (value.startsWith("abcd") ? "abcd" : "abc") + ("spareByte" in entry ? "" : extra);
    const maxBytes = Buffer.byteLength(clipped) + ("spareByte" in entry ? entry.spareByte : 0);
    let resolveAtClose: (() => Promise<string>) | undefined;
    const fake = createFakeEngine({ tree: { ref: { id: 'odd"id', revision: "" }, name: value }, secrets: [handle],
      onStartAttempt: (context) => { resolveAtClose = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { if (resolvedDuring === "cleanup") await resolveAtClose!(); },
    });
    const stored: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => value },
      artifacts: { store: { put: async (artifact) => { if (artifact.kind === "log") stored.push(Buffer.from(artifact.bytes).toString("utf8")); return { ref: "stored" }; } } },
    }) });
    const session = await opened.openSession({ name: "unfinished encoding", debugCheckpoints: { retain: "on", maxBytes } });
    await session.fixtures.app.open();
    expect(text(session.checkpoints()[0]!)).toBe("CAPTURE_UNAVAILABLE");
    if (resolvedDuring === "operation") {
      await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
      expect(text(session.checkpoints()[0]!)).not.toContain("abc");
    }
    await session.close();
    expect(session.checkpoints().map(text).join("\n")).not.toContain("abc");
    expect(stored).toHaveLength(session.checkpoints().length);
    for (const json of stored) {
      const persisted = JSON.parse(json);
      if (persisted.semantics.status === "available") expect(persisted.semantics.text).not.toContain("abc");
      expect(validate(persisted), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("withholds provider-backed collapsed engine-cut text", async () => {
    const handle = secrets.get("late");
    const observed = "X  ".repeat(169) + "XXabc";
    expect(observed).toHaveLength(512);
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, text: observed } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { late: () => "abcdef" } }) });
    const session = await opened.openSession({ name: "collapsed text", debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    expect(text(session.checkpoints()[0]!)).toBe("CAPTURE_UNAVAILABLE");
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    expect(text(session.checkpoints()[0]!)).not.toContain("abc");
    await session.close();
    expect(text(session.checkpoints()[0]!)).not.toContain("abc");
  });

  it.each([false, true])("fails closed at the scalar provenance ceiling, one node=%s", async (oneNode) => {
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, ...(oneNode
      ? { states: Object.fromEntries(Array.from({ length: 2100 }, (_, index) => [`s${index}`, true])) }
      : { children: Array.from({ length: 1200 }, (_, index) => ({ ref: { id: `n${index}`, revision: "" }, role: "text", name: "short" })) }) } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "bounded provenance", debugCheckpoints: { retain: "on", maxSteps: 1 } });
    await session.fixtures.app.open();
    expect(session.checkpoints().map((record) => record.semantics)).toEqual(Array.from({ length: 2 }, () => ({ status: "unavailable", reason: "EVIDENCE_LIMIT" })));
    await session.close();
    for (const record of session.checkpoints()) expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it("copies only schema-shaped viewport dimensions at capture time", async () => {
    const viewport = { width: 640, height: 480, scale: 2, x: 10, y: 20 };
    const fake = createFakeEngine({ onNavigate: () => { viewport.width = 800; viewport.height = 600; viewport.scale = 3; } });
    const engine = { ...fake.engine, observe: async (...args: Parameters<NonNullable<typeof fake.engine.observe>>) => ({ ...await fake.engine.observe!(...args), viewport }) };
    const opened = await host(engine);
    const session = await opened.openSession({ name: "viewport copy", debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    expect(session.checkpoints().map((record) => record.viewport)).toEqual([{ width: 640, height: 480, scale: 2 }, { width: 800, height: 600, scale: 3 }]);
    viewport.width = 999;
    viewport.scale = Number.NaN;
    await session.close();
    expect(session.checkpoints().map((record) => record.viewport)).toEqual([{ width: 640, height: 480, scale: 2 }, { width: 800, height: 600, scale: 3 }]);
    for (const record of session.checkpoints()) expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([{ width: 0, height: 480 }, { width: Number.NaN, height: 480 }, { width: 640, height: Number.POSITIVE_INFINITY }, { width: 640, height: 480, scale: -1 }, { width: 640, height: 480, scale: Number.NaN }, { width: 640, height: 480, scale: Number.POSITIVE_INFINITY }])("omits unsupported viewport values: %j", async (viewport) => {
    const fake = createFakeEngine({ pixels: () => ({ pixels }) });
    const engine = { ...fake.engine, observe: async (...args: Parameters<NonNullable<typeof fake.engine.observe>>) => ({ ...await fake.engine.observe!(...args), viewport }) };
    const opened = await host(engine);
    const session = await opened.openSession({ name: "invalid viewport", debugCheckpoints: { retain: "on", pixels: true } });
    await session.fixtures.app.open();
    await session.close();
    for (const record of session.checkpoints()) {
      expect(validate(record), JSON.stringify(validate.errors)).toBe(true);
      expect(record.viewport).toEqual(viewport.width === 640 && viewport.height === 480 ? { width: 640, height: 480 } : undefined);
      if (record.viewport === undefined) {
        expect(record.observationId).toBeUndefined();
        expect(record.capturedAt).toBeUndefined();
      }
    }
  });

  it("keeps the byte quota after late secret markers expand captured text", async () => {
    const value = "abqdef";
    const key = "veryLongSecretName";
    const handle = secrets.get(key);
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, name: `${value} `.repeat(20) } });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { [key]: () => value } }) });
    const session = await opened.openSession({ name: "expanding markers", debugCheckpoints: { retain: "on", maxBytes: 64 } });
    await session.fixtures.app.open();
    await session.fixtures.screen.getByRole("button", "Submit").fill(handle);
    for (const records of [session.checkpoints(), (await session.close(), session.checkpoints())]) {
      expect(JSON.stringify(records)).not.toContain(value);
      expect(records.reduce((total, record) => total + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(64);
    }
  });

  it("withholds masking-unproven pixels while keeping safe semantics", async () => {
    const fake = createFakeEngine({ tree: { ref: { id: "p", revision: "" }, role: "textbox", value: "hidden-password", states: { secure: true } }, pixels: () => ({ pixels, maskedRegionCount: 0 }) });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "masking", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    expect(session.checkpoints().every(({ image }) => image.status === "withheld" && image.reason === "MASKING_UNPROVEN")).toBe(true);
    expect(JSON.stringify(session.checkpoints())).not.toContain("hidden-password");
    await session.close();
    expect(readdirSync(path.join(session.artifactsDir, "debug")).some((file) => file.endsWith(".png"))).toBe(false);
  });

  it("reports unsupported pixels without calling a screenshot fallback", async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "unsupported", debugCheckpoints: { pixels: true, retain: "on" } });
    await session.fixtures.app.open();
    expect(session.checkpoints().map(({ image }) => image)).toEqual([{ status: "unavailable", reason: "UNSUPPORTED_CAPABILITY" }, { status: "unavailable", reason: "UNSUPPORTED_CAPABILITY" }]);
    expect(fake.operations.some(({ method }) => method.startsWith("artifacts.screenshot"))).toBe(false);
    await session.close();
  });

  it("cancels capture without starting the action or storing late pixels", async () => {
    const controller = new AbortController();
    const started = gate();
    const release = heldGate();
    const fake = createFakeEngine({ observe: async () => { started.resolve(); await release.promise; }, pixels: () => ({ pixels }) });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "cancel", signal: controller.signal, debugCheckpoints: { pixels: true, retain: "on", captureTimeout: 5000 } });
    const work = session.fixtures.app.open();
    const rejected = expect(work).rejects.toMatchObject({ code: "CANCELLED" });
    await started.promise;
    controller.abort();
    await rejected;
    await session.close();
    expect(fake.callsOf(session.attemptId)).toHaveLength(0);
    expect(session.checkpoints().map(({ semantics }) => semantics)).toEqual([{ status: "unavailable", reason: "CANCELLED" }, { status: "unavailable", reason: "CANCELLED" }]);
    const before = session.checkpoints();
    release.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(session.checkpoints()).toEqual(before);
    expect(readdirSync(path.join(session.artifactsDir, "debug")).some((file) => file.endsWith(".png"))).toBe(false);
  });

  it("bounds a hung capture locally without failing the action", async () => {
    const fake = createFakeEngine({ observe: () => new Promise<never>(() => undefined) });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "capture timeout", debugCheckpoints: { retain: "on", captureTimeout: 10 } });
    await session.fixtures.app.open();
    expect(session.checkpoints().map(({ semantics }) => semantics)).toEqual([{ status: "unavailable", reason: "CAPTURE_TIMEOUT" }, { status: "unavailable", reason: "CAPTURE_TIMEOUT" }]);
    expect(await session.close()).toEqual([]);
  });

  it("keeps the session deadline authoritative during a hung capture", async () => {
    const fake = createFakeEngine({ observe: () => new Promise<never>(() => undefined) });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "deadline", timeout: 30, debugCheckpoints: { retain: "on", captureTimeout: 5000 } });
    await expect(session.fixtures.app.open()).rejects.toMatchObject({ code: "TEST_TIMEOUT" });
    expect(await session.close()).toContainEqual(expect.objectContaining({ code: "TEST_TIMEOUT" }));
    expect(session.steps()[0]?.error?.code).toBe("TEST_TIMEOUT");
    expect(fake.callsOf(session.attemptId)).toHaveLength(0);
  });

  it.each([false, true])("applies failure retention before any store write, failed=%s", async (failed) => {
    const stored: unknown[] = [];
    const fake = createFakeEngine({ pixels: () => ({ pixels }) });
    const opened = await host(fake.engine, { config: config(fake.engine, { artifacts: { store: { put: async (artifact) => { stored.push(artifact); return { ref: "stored" }; } } } }) });
    const session = await opened.openSession({ name: "retention", debugCheckpoints: { pixels: true } });
    await session.fixtures.app.open();
    if (failed) sdkExpect.soft(1).toBe(2);
    expect(stored).toHaveLength(0);
    await session.close();
    expect(session.checkpoints()).toHaveLength(failed ? 2 : 0);
    expect(stored).toHaveLength(failed ? 4 : 0);
    expect(existsSync(path.join(session.artifactsDir, "debug"))).toBe(failed);
  });

  it("accepts fractional session deadlines without changing successful operations", async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "fractional", timeout: 500.5, debugCheckpoints: { retain: "on" } });
    await session.fixtures.app.open();
    expect(fake.callsOf(session.attemptId, "session").map(({ method }) => method)).toEqual(["open"]);
    expect(session.checkpoints().map(({ semantics }) => semantics.status)).toEqual(["available", "available"]);
    expect(await session.close()).toEqual([]);
  });

  it("caps captures and evidence bytes and refuses oversized images", async () => {
    const fake = createFakeEngine({ tree: { ref: { id: "s", revision: "" }, name: "界".repeat(1000) }, pixels: () => ({ pixels: { ...pixels, data: new Uint8Array(1024 * 1024 + 1) } }) });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "caps", debugCheckpoints: { pixels: true, maxSteps: 2, maxBytes: 30, retain: "on" } });
    for (let index = 0; index < 4; index++) await session.fixtures.app.open();
    expect(session.checkpoints()).toHaveLength(4);
    expect(fake.operations.filter(({ method }) => method === "observe")).toHaveLength(2);
    expect(session.checkpoints()[0]?.image).toEqual({ status: "unavailable", reason: "EVIDENCE_LIMIT" });
    expect(session.checkpoints().filter(({ semantics }) => semantics.status === "unavailable")).toHaveLength(2);
    expect(session.checkpoints().reduce((bytes, record) => bytes + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(30);
    await session.close();
  });

  it.each([{ maxSteps: 101 }, { maxSteps: 0 }, { maxBytes: Number.POSITIVE_INFINITY }, { captureTimeout: 5001 }, { pixels: "yes" }, { retain: "off" }, { callback: () => undefined }, null])("rejects invalid policies before engine launch: %j", async (policy) => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    await expect(opened.openSession({ name: "bad", debugCheckpoints: policy as DebugCheckpointPolicy })).rejects.toMatchObject({ code: "INVALID_CONFIG" });
    expect(fake.stats().attemptsStarted).toBe(0);
  });
});
