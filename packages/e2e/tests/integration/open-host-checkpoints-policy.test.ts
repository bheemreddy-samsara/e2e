/** Built public policy ownership and PNG request floor; synthetic engines only. */
import { describe, expect, it } from "vitest";
import { createFakeEngine } from "../helpers/fake-engine.ts";
import { gate, hostHarness } from "../helpers/open-host.ts";

const png = { data: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: "image/png" as const, width: 1, height: 1, scale: 1 };

describe("openHost: checkpoint policy ownership", () => {
  const { host, heldGate } = hostHarness();
  it.each(["maxSteps", "maxBytes", "pixels", "captureTimeout", "retain"] as const)("owns %s before asynchronous opening", async (key) => {
    const entered = gate(), opening = heldGate();
    let pixelCalls = 0;
    const timeouts: number[] = [];
    const fake = createFakeEngine({
      tree: { ref: { id: "root", revision: "" }, role: "status", name: "x".repeat(200) },
      onStartAttempt: async () => { entered.resolve(); await opening.promise; },
      observe: (operation) => { timeouts.push(operation.timeoutMs); },
      pixels: () => { pixelCalls++; return { pixels: png }; },
    });
    const opened = await host(fake.engine);
    const policy = { maxSteps: 1, maxBytes: 64, pixels: false, captureTimeout: 10, retain: key === "retain" ? "retain-on-failure" as const : "on" as const };
    const pending = opened.openSession({ name: "owned policy", debugCheckpoints: policy });
    await entered.promise;
    Object.assign(policy, { [key]: { maxSteps: 101, maxBytes: 16 * 1024 * 1024, pixels: true, captureTimeout: 5001, retain: "on" }[key] });
    opening.resolve();
    const session = await pending;
    await session.fixtures.app.open("/one");
    await session.fixtures.app.open("/two");
    expect(session.steps()).toHaveLength(2);
    expect(session.checkpoints()).toHaveLength(2);
    expect(session.checkpoints().reduce((sum, record) => sum + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(64);
    expect(pixelCalls).toBe(0);
    expect(timeouts.every((value) => value <= 10)).toBe(true);
    const closing = session.close();
    expect(session.close()).toBeInstanceOf(Promise);
    expect(await closing).toEqual([]);
    expect(session.checkpoints()).toHaveLength(key === "retain" ? 0 : 2);
  });
  it("reads enumerable policy getters once into owned data", async () => {
    let reads = 0;
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const policy = { get maxSteps() { return ++reads === 1 ? 1 : 101; }, retain: "on" as const };
    const session = await opened.openSession({ name: "getter policy", debugCheckpoints: new Proxy(policy, {}) });
    await session.fixtures.app.open(); await session.fixtures.app.open();
    expect(reads).toBe(1);
    expect(session.checkpoints()).toHaveLength(2);
    expect(await session.close()).toEqual([]);
  });
});

describe("openHost: PNG request floor", () => {
  const { host } = hostHarness();
  it("does not request another image when a retained capture leaves one byte", async () => {
    let pixelCalls = 0;
    const fake = createFakeEngine({ pixels: () => { pixelCalls++; return { pixels: png }; } });
    const opened = await host(fake.engine);
    const calibration = await opened.openSession({ name: "semantic bytes", debugCheckpoints: { retain: "on" } });
    await calibration.fixtures.app.open();
    const semantics = calibration.checkpoints()[0]!.semantics;
    expect(semantics.status).toBe("available");
    if (semantics.status !== "available") throw new Error("expected semantic calibration");
    const textBytes = Buffer.byteLength(semantics.text);
    expect(await calibration.close()).toEqual([]);
    const maxBytes = textBytes + png.data.byteLength + 1;
    const session = await opened.openSession({ name: "one byte left", debugCheckpoints: { pixels: true, retain: "on", maxBytes } });
    await session.fixtures.app.open();
    expect(pixelCalls).toBe(1);
    expect(session.checkpoints().map(({ image }) => image)).toEqual([{ status: "pending" }, { status: "unavailable", reason: "EVIDENCE_LIMIT" }]);
    expect(session.checkpoints().reduce((sum, record) => sum + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), png.data.byteLength)).toBeLessThanOrEqual(maxBytes);
    expect(await session.close()).toEqual([]);
    expect(session.checkpoints()[0]!.image.status).toBe("available");
    expect(session.checkpoints()[1]!.image).toEqual({ status: "unavailable", reason: "EVIDENCE_LIMIT" });
  });
  it.each([1, 7, 8])("requests pixels only when %i remaining bytes can hold a PNG signature", async (maxBytes) => {
    let pixelCalls = 0;
    const fake = createFakeEngine({ pixels: () => { pixelCalls++; return { pixels: png }; } });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: "PNG floor", debugCheckpoints: { pixels: true, retain: "on", maxBytes } });
    await session.fixtures.app.open();
    expect(pixelCalls).toBe(maxBytes < 8 ? 0 : 1);
    expect(fake.operations.filter(({ method }) => method === "observe")).toHaveLength(1);
    expect(session.checkpoints()).toHaveLength(2);
    expect(session.checkpoints().map(({ image }) => image)).toEqual(Array.from({ length: 2 }, () => ({ status: "unavailable", reason: "EVIDENCE_LIMIT" })));
    expect(session.checkpoints().reduce((sum, record) => sum + (record.semantics.status === "available" ? Buffer.byteLength(record.semantics.text) : 0), 0)).toBeLessThanOrEqual(maxBytes);
    expect(await session.close()).toEqual([]);
  });
});
