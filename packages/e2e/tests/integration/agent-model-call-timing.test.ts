/** Built public helper + hosted runner + real SDK retry; only Date and timer scheduling are accelerated. */
import * as ai from 'ai';
import { describe, expect, it, vi } from 'vitest';
import type { ModelInstance } from '../../src/index.ts';
import { asSdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

const agentModule = new URL('../../dist/agent/public.js', import.meta.url).href;
const { createToolLoopExecutor } = await import(agentModule) as typeof import('../../src/agent/public.ts');
const done = () => scriptedResult([
  { type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'done' }) },
], 'tool-calls');

/** Borrows the real runner context without synthesizing accounting authority. */
function helper(model: ModelInstance, pixels = false) {
  return createToolLoopExecutor({
    name: 'timing-helper', observationPolicy: true, model: asSdkLanguageModel(model), tools: () => ({}),
    buildPrompt: async () => pixels
      ? [{ role: 'user', content: [{ type: 'text', text: 'tree' }, { type: 'file', mediaType: 'image/png', data: new Uint8Array(8) }] }]
      : 'tree',
  });
}

describe('hosted logical model-call timing', { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();

  it.each(['stall', 'provider error', 'image rejection'] as const)(
    'times a %s retry and a subsequent normal call', async (failure) => {
      const firstEntered = heldGate(), retryEntered = heldGate(), nextEntered = heldGate();
      const firstRelease = heldGate(), retryRelease = heldGate(), nextRelease = heldGate();
      const sentAt: number[] = [];
      let firstEnd = 0, nextEnd = 0;
      const executor = helper(createScriptedInstance('synthetic', `timing-${failure}`, async () => {
        sentAt.push(Date.now());
        if (sentAt.length === 1) {
          firstEntered.resolve();
          await firstRelease.promise; // The stall case deliberately ignores abort.
          if (failure === 'image rejection') throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
          throw new ai.APICallError({ message: 'retryable error', url: 'synthetic', requestBodyValues: undefined, isRetryable: true });
        }
        if (sentAt.length === 2) {
          retryEntered.resolve();
          await retryRelease.promise;
        } else {
          nextEntered.resolve();
          await nextRelease.promise;
        }
        return done();
      }), failure === 'image rejection');
      const fake = createFakeEngine();
      const opened = await host(fake.engine, { config: config(fake.engine, {
        timeout: 180_000, cache: 'off', agents: { default: {
          observationPolicy: { act: 'tree+pixels' }, maxModelCalls: 3, maxInputTokens: 30_000,
          executor: { name: 'caller', observationPolicy: true, async runStep(context) {
            const running = executor.runStep(context);
            await firstEntered.promise;
            if (failure === 'stall') {
              // Production 120000ms stall plus the SDK's real 2000ms retry backoff.
              await vi.advanceTimersByTimeAsync(122_001);
            } else {
              await vi.advanceTimersByTimeAsync(100);
              firstRelease.resolve();
              await new Promise<void>((resolve) => setImmediate(resolve));
              if (failure === 'provider error') await vi.advanceTimersByTimeAsync(2_000);
            }
            await retryEntered.promise;
            await vi.advanceTimersByTimeAsync(200);
            retryRelease.resolve();
            await running;
            firstEnd = Date.now();
            const next = executor.runStep(context);
            await nextEntered.promise;
            await vi.advanceTimersByTimeAsync(500);
            nextRelease.resolve();
            const verdict = await next;
            nextEnd = Date.now();
            return verdict;
          } },
        } },
      }) });
      const session = await opened.openSession({ name: `logical-timing-${failure}` });
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
      try {
        await session.fixtures.agent.act('retry then a normal logical call');
        const step = session.steps()[0]!;
        const events = step.events.filter((event) => event.kind === 'model');
        const accepted = events[failure === 'image rejection' ? 1 : 0]!;
        const logicalStart = sentAt[failure === 'stall' ? 0 : 1]!;
        console.info('logical-call timing', { failure, sentAt, accepted, next: events.at(-1) });
        expect(sentAt).toHaveLength(3);
        expect(events).toHaveLength(failure === 'image rejection' ? 3 : 2);
        expect(step.metrics!.modelCalls).toBe(events.length);
        expect.soft(accepted.startedAt).toBe(new Date(logicalStart).toISOString());
        expect.soft(accepted.durationMs).toBe(firstEnd - logicalStart);
        expect.soft(accepted.durationMs).toBe(failure === 'stall' ? 122_201 : 200);
        expect(events.at(-1)!.startedAt).toBe(new Date(sentAt[2]!).toISOString());
        expect(events.at(-1)!.durationMs).toBe(nextEnd - sentAt[2]!);
        expect(events.at(-1)!.durationMs).toBe(500);
      } finally {
        firstRelease.resolve(); retryRelease.resolve(); nextRelease.resolve();
        vi.useRealTimers();
        await session.close();
      }
    },
  );

  it('rechecks a retained lease after a caught hard stop during SDK backoff', async () => {
    const entered = heldGate(), abandonedRelease = heldGate();
    let transports = 0, refused: unknown, retryError: unknown;
    const a = helper(createScriptedInstance('synthetic', 'timing-hard-stop', async () => {
      transports++;
      if (transports === 1) { entered.resolve(); await abandonedRelease.promise; }
      return done();
    }));
    const b = helper(createScriptedInstance('synthetic', 'must-not-send', async () => {
      transports++;
      return done();
    }));
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, {
      timeout: 180_000, cache: 'off', agents: { default: {
        maxModelCalls: 1,
        executor: { name: 'caller', async runStep(context) {
          const running = a.runStep(context).catch((error: unknown) => { retryError = error; });
          await entered.promise;
          await vi.advanceTimersByTimeAsync(120_001);
          try { await b.runStep(context); } catch (error) { refused = error; }
          await vi.advanceTimersByTimeAsync(2_001);
          await running;
          return { status: 'passed', summary: 'caught the hard stop' };
        } },
      } },
    }) });
    const session = await opened.openSession({ name: 'logical-timing-hard-stop' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await expect(session.fixtures.agent.act('hard stop before retained retry')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
      expect(refused).toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
      // The SDK wraps a refusal after an earlier retryable error; the hosted hard stop stays sticky.
      expect(retryError).toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
      expect(transports).toBe(1);
      expect(session.steps()[0]!.metrics!.modelCalls).toBe(0);
    } finally {
      abandonedRelease.resolve();
      vi.useRealTimers();
      await session.close();
    }
  });

  it('starts a new timer for the next SDK turn in the same helper run', async () => {
    const entered = [heldGate(), heldGate()], release = [heldGate(), heldGate()];
    const sentAt: number[] = [];
    const model = createScriptedInstance('synthetic', 'sequential-turn-timing', async () => {
      const index = sentAt.length;
      sentAt.push(Date.now());
      entered[index]!.resolve();
      await release[index]!.promise;
      return index === 0 ? scriptedResult([
        { type: 'tool-call', toolCallId: 'proceed', toolName: 'proceed', input: '{}' },
      ], 'tool-calls') : done();
    });
    const executor = createToolLoopExecutor({
      name: 'sequential-helper', model: asSdkLanguageModel(model), buildPrompt: async () => 'tree',
      tools: () => ({ proceed: ai.tool({
        inputSchema: ai.jsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
        execute: async () => 'continue',
      }) }),
    });
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, {
      timeout: 180_000, cache: 'off', agents: { default: {
        maxModelCalls: 4,
        executor: { name: 'caller', async runStep(context) {
          const running = executor.runStep(context);
          await entered[0]!.promise;
          await vi.advanceTimersByTimeAsync(100);
          release[0]!.resolve();
          await entered[1]!.promise;
          await vi.advanceTimersByTimeAsync(300);
          release[1]!.resolve();
          return running;
        } },
      } },
    }) });
    const session = await opened.openSession({ name: 'sequential-turn-timing' });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      await session.fixtures.agent.act('two logical calls in one loop');
      const step = session.steps()[0]!;
      const events = step.events.filter((event) => event.kind === 'model');
      expect(sentAt).toHaveLength(2);
      expect(events.map((event) => event.startedAt)).toEqual(sentAt.map((time) => new Date(time).toISOString()));
      expect(events.map((event) => event.durationMs)).toEqual([100, 300]);
      expect(step.metrics!.modelCalls).toBe(2);
    } finally {
      release.forEach((gate) => gate.resolve());
      vi.useRealTimers();
      await session.close();
    }
  });
});
