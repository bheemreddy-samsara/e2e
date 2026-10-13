/** Real hosted admission and SDK stall/retry ordering, with only the timer clock accelerated. */
import { describe, expect, it, vi } from 'vitest';
import type { ModelInstance } from '../../src/index.ts';
import { asSdkLanguageModel } from '../../src/agent/ai-sdk.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';
const agentModule = new URL('../../dist/agent/public.js', import.meta.url).href;
const { createToolLoopExecutor } = await import(agentModule) as typeof import('../../src/agent/public.ts');
const done = (warnings: Parameters<typeof scriptedResult>[2] = []) => scriptedResult([
  { type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'done' }) },
], 'tool-calls', warnings);
const imageRejection = () => Object.assign(new Error('model does not support images'), { statusCode: 400 });
/** A public supported helper, borrowing the actual runner context. */
function helper(model: ModelInstance, pixels: boolean) {
  return createToolLoopExecutor({ name: 'stall-helper', observationPolicy: true, model: asSdkLanguageModel(model), tools: () => ({}),
    buildPrompt: async () => pixels ? [{ role: 'user', content: [{ type: 'text', text: 'tree' }, { type: 'file', mediaType: 'image/png', data: new Uint8Array(8) }] }] : 'tree' });
}
describe('hosted admission after an abandoned generation', { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();
  it.each(['failure', 'image rejection', 'replacement failure', 'ignored images', 'forced result', 'image success'] as const)(
    'retains the live retry reservation after late %s', async (late) => {
      const firstEntered = heldGate(), retryEntered = heldGate(), retryRelease = heldGate(), abandonedRelease = heldGate();
      const replacement = late === 'replacement failure';
      const pixels = late !== 'failure' && late !== 'forced result';
      const limit = replacement ? 2 : 1;
      let aTransports = 0, bTransports = 0, responses = 0;
      let refusal: unknown, retryStatus: string | undefined;
      const signals: (AbortSignal | undefined)[] = [];
      const a = helper(createScriptedInstance('synthetic', `abandoned-${late}`, async (options: { abortSignal?: AbortSignal }) => {
        aTransports++; signals.push(options.abortSignal);
        if (replacement && aTransports === 1) throw imageRejection();
        if (aTransports === (replacement ? 2 : 1)) {
          firstEntered.resolve();
          await abandonedRelease.promise; // Deliberately ignore this generation's abort.
          if (late === 'failure' || replacement) throw new Error('late abandoned failure');
          if (late === 'image rejection') throw imageRejection();
          responses++;
          if (late === 'forced result') return scriptedResult([{ type: 'tool-call', toolCallId: 'wrong', toolName: 'not_offered', input: '{}' }], 'tool-calls');
          return done(late === 'ignored images' ? [{ type: 'unsupported', feature: 'image input' }] : []);
        }
        retryEntered.resolve();
        await retryRelease.promise;
        responses++;
        return done();
      }), pixels);
      const b = helper(createScriptedInstance('synthetic', `other-${late}`, async () => { bTransports++; responses++; return done(); }), false);
      const fake = createFakeEngine();
      const opened = await host(fake.engine, { config: config(fake.engine, { timeout: 140_000, cache: 'off', agents: { default: {
        observationPolicy: { act: 'tree+pixels' }, maxModelCalls: limit, maxInputTokens: 30_000,
        executor: { name: 'caller', observationPolicy: true, async runStep(context) {
          const running = a.runStep(context);
          await firstEntered.promise;
          await vi.advanceTimersByTimeAsync(122_001); // Unchanged 120s production stall plus actual SDK backoff.
          await retryEntered.promise;
          expect(signals[replacement ? 1 : 0]!.aborted).toBe(true);
          expect(signals.at(-1)!.aborted).toBe(false);
          abandonedRelease.resolve();
          await new Promise<void>((resolve) => setImmediate(resolve));
          await new Promise<void>((resolve) => setImmediate(resolve));
          try { await b.runStep(context); } catch (cause) { refusal = cause; }
          retryRelease.resolve();
          const outcomes = await Promise.allSettled([running]);
          retryStatus = outcomes[0]!.status;
          return { status: 'passed', summary: 'waited for the live retry' };
        } },
      } } }) });
      const session = await opened.openSession({ name: `abandoned-${late}` });
      await import('ai');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        await expect(session.fixtures.agent.act('held stall retry')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
        expect(aTransports).toBe(replacement ? 3 : 2);
        expect(bTransports).toBe(0);
        expect(refusal).toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
        expect(retryStatus).toBe('fulfilled');
        // Late raw responses have no stall-race reader. Only the live response is accepted/accounted.
        expect(responses).toBe(['ignored images', 'forced result', 'image success'].includes(late) ? 2 : 1);
        const step = session.steps()[0]!;
        expect(step.metrics!.modelCalls).toBe(limit);
        expect(step.model!.inputTokens).toBe(100);
        expect(step.model!.outputTokens).toBe(20);
        expect(step.metrics!.modelImageBytes).toBe(pixels && !replacement ? 8 : undefined);
        expect(step.visionDegraded).toBe(replacement ? 'MODEL_IMAGES_UNSUPPORTED' : undefined);
      } finally {
        abandonedRelease.resolve(); retryRelease.resolve();
        vi.useRealTimers();
        await session.close();
      }
    },
  );
});
