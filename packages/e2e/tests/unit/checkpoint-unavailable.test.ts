/** Private protocol consistency controls, not public ingress or a new SDK exploit finding. */
import { expect, it } from "vitest";
import { checkpointUnavailableBytesProven, type CheckpointUnavailableFacts } from "../../src/run/checkpoint-unavailable.ts";

const attemptedAt = "2026-01-01T00:00:00.000Z";
const semanticReasons = ["UNSUPPORTED_CAPABILITY", "CAPTURE_UNAVAILABLE", "CAPTURE_TIMEOUT", "CANCELLED", "EVIDENCE_LIMIT"] as const;
const imageReasons = [...semanticReasons, "ARTIFACT_UNAVAILABLE"] as const;

/** Direct facts stand for original sink/ticket snapshots, never mutable public registration fields. */
function fixture(phase: "before" | "after" = "before", time = attemptedAt) {
  const facts: CheckpointUnavailableFacts = {
    attemptId: "attempt", stepId: "attempt:0", attemptedAt: time,
    association: { checkpointId: `attempt:0:checkpoint:${phase}`, phase, observationId: null, observationRevision: null },
  };
  const record = { format: "debug-checkpoint-1", id: facts.association!.checkpointId,
    attemptId: facts.attemptId, stepId: facts.stepId, stepIndex: 0, phase, attemptedAt: time,
    semantics: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" as string },
    image: { status: "unavailable", reason: "CAPTURE_UNAVAILABLE" as string } };
  return { facts, record };
}

const positives = (["before", "after"] as const).flatMap((phase) => semanticReasons.flatMap((semantics) =>
  imageReasons.flatMap((image) => [false, true].map((lf) => ({ phase, semantics, image, lf })))));
it.each(positives)("admits original $phase null-capture facts, $semantics/$image, LF=$lf", ({ phase, semantics, image, lf }) => {
  const { facts, record } = fixture(phase);
  record.semantics.reason = semantics; record.image.reason = image;
  expect(checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(record) + (lf ? "\n" : "")), facts)).toBe(true);
});

it("denies undefined original facts without throwing", () => {
  expect(checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(fixture().record)), undefined)).toBe(false);
});

it.each(["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"])("denies non24 ISO original fact %s as preventive protocol consistency", (time) => {
  const { facts, record } = fixture("before", time);
  expect(new Date(time).toISOString()).toBe(time);
  expect(time.length).not.toBe(24);
  expect(checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(record)), facts)).toBe(false);
});

it.each(["during", "", "BEFORE", "before\n"])("denies invalid original phase %j as preventive protocol consistency", (phase) => {
  const { facts, record } = fixture();
  // The live SDK association factory already denies these phases before this private helper.
  const invalidFacts = { ...facts, association: { ...facts.association!, phase, checkpointId: `attempt:0:checkpoint:${phase}` } } as unknown as CheckpointUnavailableFacts;
  const invalidRecord = { ...record, phase, id: invalidFacts.association!.checkpointId };
  expect(checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(invalidRecord)), invalidFacts)).toBe(false);
});

it.each([undefined, "2026-01-02T00:00:00.000Z"])("requires original timestamp equality, original=%s", (time) => {
  const { facts, record } = fixture();
  expect(checkpointUnavailableBytesProven(Buffer.from(JSON.stringify(record)), { ...facts, attemptedAt: time })).toBe(false);
});
