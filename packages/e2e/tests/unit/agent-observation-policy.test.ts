import { describe, expect, it } from 'vitest';
import { resolveAgentConfig } from '../../src/config/agent.ts';
import { createBuiltInAgent } from '../../src/agent/default-agent.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';

const complete = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];

describe('agent observation policy', () => {
  it('preserves defaults and rejects invalid policy and unsupported custom executors', () => {
    expect(resolveAgentConfig(undefined).observationPolicy).toEqual({ act: 'adaptive', judgments: false });
    expect(() => resolveAgentConfig({ observationPolicy: { act: 'only' } } as never)).toThrow(/observationPolicy/);
    expect(() => resolveAgentConfig({ executor: { name: 'custom', runStep: async () => ({ status: 'passed', summary: 'ok' }) }, observationPolicy: { act: 'tree+pixels' } })).toThrow(/capability|support/i);
  });

  it('rejects inherited judgment pixels without executor vision capability', () => {
    expect(() => resolveAgentConfig({ executor: { name: 'incapable', runStep: async () => ({ status: 'passed', summary: 'done' }) }, observationPolicy: { judgments: true } })).toThrow(/vision|support/i);
  });

  it('requests pixels in the opening observation despite interactive tree nodes', async () => {
    const model = installFakeLoopModel(() => complete);
    const fake = fakeExecutorContext();
    const requests: unknown[] = [];
    const original = fake.context.observe;
    const context = { ...fake.context, model, step: { ...fake.context.step, observation: 'tree+pixels' as const }, observe: async (options?: Parameters<typeof original>[0]) => { requests.push(options); return { revision: 'r1', text: '#n1 button "Go"', truncated: false, viewport: { width: 100, height: 100 } }; } };
    await createBuiltInAgent().runStep(context);
    expect(requests[0]).toEqual({ pixels: true });
    expect(loopCalls).toHaveLength(1);
  });

  it('tree-only explicitly leaves out the pixel tools and the opening pixel fallback', async () => {
    const model = installFakeLoopModel(() => complete);
    const fake = fakeExecutorContext();
    const requests: unknown[] = [];
    await createBuiltInAgent().runStep({ ...fake.context, model, step: { ...fake.context.step, observation: 'tree-only' }, observe: async (options) => { requests.push(options); return { revision: 'r1', text: '#n1 button "Go"', truncated: false, viewport: { width: 100, height: 100 } }; } });
    expect(requests).toEqual([undefined]);
    for (const name of ['screenshot', 'tap_at', 'hover_at', 'type_at', 'press_at', 'select_at']) {
      expect(loopCalls[0]!.toolNames).not.toContain(name);
    }
  });
});
