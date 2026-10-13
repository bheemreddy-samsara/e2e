/** Real hosted contexts and built public helpers; synthetic transport, not device validation. */
import { describe, expect, it } from 'vitest';
import type { ModelInstance, StepExecutor, StepExecutorContext } from '../../src/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';
import { asSdkLanguageModel } from '../../src/agent/ai-sdk.ts';
const agentModule = new URL('../../dist/agent/public.js', import.meta.url).href;
const { createToolLoopExecutor } = await import(agentModule) as typeof import('../../src/agent/public.ts');
const done = () => scriptedResult([{ type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'done' }) }], 'tool-calls');
/** One supported public helper, not an opaque executor transport. */
function helper(model: ModelInstance, pixels = false) {
  return createToolLoopExecutor({ name: 'helper', observationPolicy: true, model: asSdkLanguageModel(model), tools: () => ({}),
    buildPrompt: async () => pixels ? [{ role: 'user', content: [{ type: 'text', text: 'tree' }, { type: 'file', mediaType: 'image/png', data: new Uint8Array(8) }] }] : 'tree' });
}
describe('hosted public helper model admission', { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();
  async function open(executor: StepExecutor, maxModelCalls = 1, maxInputTokens = 30_000) {
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: 'off', agents: { default: { executor, maxModelCalls, maxInputTokens, observationPolicy: { act: 'tree+pixels' } } } }) });
    return opened.openSession({ name: 'admission' });
  }
  it('refuses a retained ended context without changing records, aborting ownership, or harming the next step', async () => {
    let retained: StepExecutorContext | undefined, transports = 0;
    const loop = helper(createScriptedInstance('synthetic', 'retained', async () => { transports++; return done(); }));
    const session = await open({ name: 'caller', observationPolicy: true, async runStep(context) {
      if (context.step.instruction === 'retain') { retained = context; return { status: 'passed', summary: 'retained' }; }
      return loop.runStep(context);
    } });
    await session.fixtures.agent.act('retain');
    const before = structuredClone(session.steps());
    expect(retained!.signal.aborted).toBe(false);
    await expect(loop.runStep(retained!)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(transports).toBe(0);
    expect(session.steps()).toEqual(before);
    expect(retained!.signal.aborted).toBe(false);
    await session.fixtures.agent.act('next');
    expect(transports).toBe(1);
    expect(session.steps()[1]!.status).toBe('passed');
    await session.close();
  });
  it('reserves concurrent helper admission and keeps a caught refusal sticky', async () => {
    const entered = heldGate(), release = heldGate();
    let transports = 0;
    const loop = helper(createScriptedInstance('synthetic', 'parallel', async () => {
      transports++; entered.resolve(); await release.promise; return done();
    }));
    const session = await open({ name: 'caller', observationPolicy: true, async runStep(context) {
      const settled = Promise.allSettled([loop.runStep(context), loop.runStep(context)]);
      await entered.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      release.resolve();
      await settled;
      try { await loop.runStep(context); } catch { /* Caller cannot erase a refusal. */ }
      return { status: 'passed', summary: 'caught' };
    } });
    await expect(session.fixtures.agent.act('parallel')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(transports).toBe(1);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(1);
    expect(session.steps()[0]!.model!.inputTokens).toBe(100);
    await session.close();
  });
  it('refuses sequential calls without double-counting accepted usage', async () => {
    let transports = 0;
    const loop = helper(createScriptedInstance('synthetic', 'sequential', async () => { transports++; return done(); }));
    const session = await open({ name: 'caller', observationPolicy: true, async runStep(context) {
      await loop.runStep(context);
      try { await loop.runStep(context); } catch { /* Deliberately caught. */ }
      return { status: 'passed', summary: 'caught' };
    } });
    await expect(session.fixtures.agent.act('sequential')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(transports).toBe(1);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(1);
    await session.close();
  });
  it('releases admission after transport failure without phantom accepted calls', async () => {
    let failed = 0, accepted = 0;
    const broken = helper(createScriptedInstance('synthetic', 'broken', async () => { failed++; throw new Error('transport failed'); }));
    const working = helper(createScriptedInstance('synthetic', 'working', async () => { accepted++; return done(); }));
    const session = await open({ name: 'caller', observationPolicy: true, async runStep(context) {
      try { await broken.runStep(context); } catch { /* Retry belongs to the caller. */ }
      return working.runStep(context);
    } });
    await session.fixtures.agent.act('recover');
    expect([failed, accepted]).toEqual([1, 1]);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(1);
    await session.close();
  });
  it.each([1, 2])('reconciles image rejection and replacement at maxModelCalls=%s', async (limit) => {
    let transports = 0;
    const loop = helper(createScriptedInstance('synthetic', 'rejection', async () => {
      if (++transports === 1) throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
      return done();
    }), true);
    const session = await open(loop, limit);
    if (limit === 1) await expect(session.fixtures.agent.act('image')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    else await session.fixtures.agent.act('image');
    expect(transports).toBe(limit);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(limit);
    expect(session.steps()[0]!.model!.inputTokens).toBe(limit === 1 ? 0 : 100);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    await session.close();
  });
  it('preflight refusal stays sticky with zero transport, accepted usage, or rejection charge', async () => {
    let transports = 0;
    const model = createScriptedInstance('synthetic', 'preflight', async () => { transports++; return done(); });
    const small = helper(model);
    const large = createToolLoopExecutor({ name: 'large', observationPolicy: true, model: asSdkLanguageModel(model), tools: () => ({}), buildPrompt: async () => 'x'.repeat(20_000) });
    const session = await open({ name: 'caller', observationPolicy: true, async runStep(context) {
      try { await large.runStep(context); } catch { /* Deliberately caught. */ }
      try { await small.runStep(context); } catch { /* Refusal must persist. */ }
      return { status: 'passed', summary: 'caught' };
    } }, 1, 8_000);
    await expect(session.fixtures.agent.act('too large')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(transports).toBe(0);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(0);
    expect(session.steps()[0]!.model).toBeUndefined();
    await session.close();
  });
});
