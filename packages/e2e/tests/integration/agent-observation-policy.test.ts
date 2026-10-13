/** Built hosted SDK against synthetic engine/model transports. Not device validation. */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { E2EConfig, ModelInstance, StepExecutor } from '../../src/index.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness, secrets } from '../helpers/open-host.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';
import { installFakeModel, fakeCalls } from '../helpers/fake-model.ts';
import { createToolLoopExecutor } from '../../src/agent/tool-loop.ts';
import { defineTool } from '../../src/agent/tool.ts';

const image = { data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), mediaType: 'image/png' as const, width: 10, height: 10, scale: 1 };
const realImage = { ...image, data: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64')), width: 1, height: 1 };
const done = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];
const holds = { protocolVersion: 'agent-judgment-2', verdict: 'holds', explanation: 'visible' };

describe('hosted agent safe observation policy', { timeout: 60_000 }, () => {
  const { host, config } = hostHarness();
  async function open(extra: Partial<E2EConfig>, behavior: Parameters<typeof createFakeEngine>[0] = {}) {
    const fake = createFakeEngine({ pixels: () => ({ pixels: image }), ...behavior });
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: 'off', ...extra }) });
    const session = await opened.openSession({ name: 'safe model observations' });
    return { fake, session };
  }

  it('checks retained and duplicate images added by prepareMessages before transport, without redispatching a mutation', async () => {
    const file = { type: 'file' as const, mediaType: realImage.mediaType, data: realImage.data };
    let mutations = 0;
    const model = installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'commit_once', input: {} }] : done);
    const executor = createToolLoopExecutor({
      name: 'prepared-pixels', observationPolicy: true,
      tools: (context, helpers) => ({ commit_once: { inputSchema: z.object({}), execute: () => helpers.guard(() => context.budgets.runTool({ name: 'commit_once', mutates: true }, async () => { mutations++; return 'committed'; })) } }),
      buildPrompt: async (context) => {
        await context.observe({ pixels: true });
        return [{ role: 'user', content: [{ type: 'text', text: context.step.instruction }, file] }];
      },
      prepareMessages: (messages, turn) => turn.stepNumber === 0 ? messages : [...messages,
        { role: 'user', content: [{ type: 'text', text: 'Fresh evidence with retained duplicate images' }, file, file] },
      ],
    });
    const { session } = await open({ agents: { default: { executor, model, maxInputTokens: 8_500, observationPolicy: { act: 'tree+pixels' } } } }, { pixels: () => ({ pixels: realImage }) });
    await expect(session.fixtures.agent.act('commit once')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(mutations).toBe(1);
    expect(loopCalls).toHaveLength(1);
    const step = session.steps()[0]!;
    expect(step.metrics!.actionSteps).toBe(1);
    expect(step.metrics!.modelCalls).toBe(1);
    expect(step.metrics!.modelImageBytes).toBe(realImage.data.length);
    expect(step.model!.inputTokens).toBe(100);
    expect(step.visionInput).toBe(true);
    await session.close();
  });

  it.each([false, true])('stops after a dispatched project mutation with uncertain failure=%s when fresh prepared input cannot fit', async (uncertain) => {
    let mutations = 0;
    const tree = { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go' };
    const commit_once = defineTool({ inputSchema: z.object({}), execute: async () => {
      mutations++;
      tree.name = 'Done '.repeat(1_000);
      if (uncertain) throw new Error('mutation may have committed');
      return 'committed';
    } }, { mutates: true });
    const model = installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'commit_once', input: {} }] : done);
    const { session } = await open({ agents: { default: { model, tools: { commit_once }, maxInputTokens: 26_000, observationPolicy: { act: 'tree+pixels' } } } }, {
      pixels: () => ({ pixels: realImage }),
      tree,
    });
    await expect(session.fixtures.agent.act('commit once')).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(mutations).toBe(1);
    expect(loopCalls).toHaveLength(1);
    expect(session.steps()[0]!.metrics!.actionSteps).toBe(1);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(1);
    expect(session.steps()[0]!.metrics!.modelImageBytes).toBe(realImage.data.length);
    await session.close();
  });

  it('preserves inherited text-only ceilings and instruction hard limits outside opt-in requests', async () => {
    const model = installFakeLoopModel(() => done);
    const { session } = await open({ agents: { default: { model, maxInputTokens: 1 }, visual: { model, maxInputTokens: 1, observationPolicy: { act: 'tree+pixels' } } } });
    await session.fixtures.agent.act('legacy adaptive');
    await session.fixtures.agent.act('explicit tree only', { agent: 'visual', observation: 'tree-only' });
    expect(loopCalls).toHaveLength(2);
    expect(loopCalls.every((call) => call.imageParts === 0)).toBe(true);
    await expect(session.fixtures.agent.act('x'.repeat(8_193), { agent: 'visual' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT', message: expect.stringContaining('instruction is 8193 bytes') });
    expect(loopCalls).toHaveLength(2);
    await session.close();
  });

  it('uses a safe image on the first turn and a refreshed image after exactly one action', async () => {
    const model = installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'tap', input: { target: 'node-1' } }] : done);
    let captures = 0;
    const { fake, session } = await open({ agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } }, {
      pixels: () => { captures++; return { pixels: { ...image, data: new Uint8Array([...image.data, captures]) } }; },
    });
    const result = await session.fixtures.agent.act('tap submit');
    expect(result.actions).toBe(1);
    expect(fake.callsOf(session.attemptId, 'perform')).toHaveLength(1);
    expect(loopCalls[0]!.imageParts).toBe(1);
    expect(loopCalls[1]!.lastToolResult).toContain('Screenshot attached');
    const step = session.steps()[0]!;
    expect(step.visionInput).toBe(true);
    expect(step.metrics!.modelImageBytes).toBeGreaterThan(image.data.byteLength);
    expect(step.model!.calls).toBe(2);
    expect(step.model!.inputTokens).toBeGreaterThan(0);
    await session.close();
  });

  it('preserves adaptive default and named-agent isolation, with a tree-only per-call override', async () => {
    const model = installFakeLoopModel(() => done);
    const { session } = await open({ agents: { default: { model }, pixels: { model, observationPolicy: { act: 'tree+pixels' } } } });
    await session.fixtures.agent.act('default');
    expect(loopCalls.at(-1)!.imageParts).toBe(0);
    await session.fixtures.agent.act('pixels', { agent: 'pixels' });
    expect(loopCalls.at(-1)!.imageParts).toBe(1);
    await session.fixtures.agent.act('tree', { agent: 'pixels', observation: 'tree-only' });
    expect(loopCalls.at(-1)!.imageParts).toBe(0);
    expect(loopCalls.at(-1)!.toolNames).not.toContain('screenshot');
    expect(session.steps().at(-1)!.visionInput).toBeUndefined();
    await session.close();
  });

  it.each(['UNSUPPORTED_CAPABILITY', 'MASKING_UNPROVEN'] as const)('degrades safely with %s', async (reason) => {
    const model = installFakeLoopModel(() => done);
    const { session } = await open({ agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } }, reason === 'UNSUPPORTED_CAPABILITY' ? { pixels: () => undefined } : {
        tree: { ref: { id: 'root', revision: '' }, children: [
          { ref: { id: 'submit', revision: '' }, role: 'button', name: 'Submit' },
          { ref: { id: 'password', revision: '' }, role: 'textbox', states: { secure: true } },
        ] },
        pixels: () => ({ pixels: image, maskedRegionCount: 0 }),
      });
    await session.fixtures.agent.act('observe');
    expect(loopCalls[0]!.imageParts).toBe(0);
    expect(session.steps()[0]!.visionDegraded).toBe(reason);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    await session.close();
  });

  it('removes previous-turn images after secret fill and records taint, without recapturing pixels', async () => {
    const token = secrets.get('token');
    let captures = 0;
    const model = installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'type_secret', input: { target: 'token', name: 'token' } }] : done);
    const { session } = await open({ secrets: { token: 'synthetic-secret-never-a-key' }, agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } }, {
      tree: { ref: { id: 'root', revision: '' }, children: [
        { ref: { id: 'token', revision: '' }, role: 'textbox', name: 'Token' },
        { ref: { id: 'submit', revision: '' }, role: 'button', name: 'Submit' },
      ] },
      pixels: () => { captures++; return { pixels: realImage }; },
    });
    await session.fixtures.agent.act('fill token', { params: { token } });
    expect(loopCalls[0]!.imageParts).toBe(1);
    expect(loopCalls[1]!.imageParts).toBe(0);
    expect(session.steps()[0]!.visionDegraded).toBe('PIXEL_TAINTED');
    expect(JSON.stringify(loopCalls)).not.toContain('synthetic-secret-never-a-key');
    const before = captures;
    await session.fixtures.agent.act('next observation');
    expect(captures).toBe(before);
    expect(loopCalls.at(-1)!.imageParts).toBe(0);
    await session.close();
  });

  it('an explicit text-only model veto degrades without submitting an image', async () => {
    const model = { ...installFakeLoopModel(() => done), supportsImageInput: false };
    const { session } = await open({ agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } });
    await session.fixtures.agent.act('observe');
    expect(loopCalls[0]!.imageParts).toBe(0);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    expect(session.steps()[0]!.metrics!.pixelBytes).toBeUndefined();
    expect(session.steps()[0]!.visionDegraded).toBe('MODEL_IMAGES_UNSUPPORTED');
    await session.close();
  });

  it('a provider image rejection retries only the request, not earlier actions, and remembers its support', async () => {
    const base = installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'tap', input: { target: 'node-1' } }] : done);
    const generate = base.doGenerate as (options: { prompt: unknown }) => Promise<unknown>;
    let requests = 0;
    const model = { ...base, doGenerate: async (options: { prompt: unknown }) => {
      requests++;
      if (requests === 2) throw Object.assign(new Error('model does not support image input'), { statusCode: 400 });
      return generate(options);
    } } as ModelInstance;
    const { fake, session } = await open({ agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } });
    await session.fixtures.agent.act('one tap');
    expect(requests).toBe(3);
    expect(fake.callsOf(session.attemptId, 'perform')).toHaveLength(1);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(3);
    expect(session.steps()[0]!.visionDegraded).toBe('MODEL_IMAGES_UNSUPPORTED');
    expect(session.steps()[0]!.visionInput).toBe(true);
    await session.close();
  });

  it('reports both requests when a provider rejection is followed by a failed replacement', async () => {
    const base = installFakeLoopModel(() => done);
    let requests = 0;
    const model = { ...base, doGenerate: async () => {
      if (++requests === 1) throw Object.assign(new Error('model does not support image input'), { statusCode: 400 });
      throw new Error('replacement failed');
    } } as ModelInstance;
    const { session } = await open({ agents: { default: { model, observationPolicy: { act: 'tree+pixels' } } } });
    await expect(session.fixtures.agent.act('observe')).rejects.toMatchObject({ code: 'MODEL_PROVIDER_FAILED' });
    expect(requests).toBe(2);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(2);
    expect(session.steps()[0]!.model!.calls).toBe(2);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    await session.close();
  });

  it('judgment defaults apply to assert, waitFor, extract, while false overrides and only stays strict', async () => {
    const model = installFakeModel((call) => call.schemaName === 'agent-extract-2' ? { found: true, value: { label: 'Submit' }, missing: null } : holds);
    const { session } = await open({ agents: { default: { model, observationPolicy: { judgments: true } } } });
    await session.fixtures.agent.assert('visible', { screenshot: false });
    await session.fixtures.agent.waitFor('visible');
    await session.fixtures.agent.extract('label', { schema: z.object({ label: z.string() }) });
    expect(fakeCalls.map((call) => call.images.length)).toEqual([1, 1, 1]);
    await session.fixtures.agent.assert('tree', { vision: false, screenshot: false });
    await session.fixtures.agent.waitFor('tree', { vision: false });
    await session.fixtures.agent.extract('label', { vision: false, schema: z.object({ label: z.string() }) });
    expect(fakeCalls.slice(3).map((call) => call.images.length)).toEqual([0, 0, 0]);
    expect(session.steps().slice(0, 3).every((step) => step.visionInput === true)).toBe(true);
    await session.close();
  });

  it('strict pixel-only judgment rejects a text-only model rather than answering from the tree', async () => {
    const model = { ...installFakeModel(() => holds), supportsImageInput: false };
    const { session } = await open({ agents: { default: { model, observationPolicy: { judgments: true } } } });
    await session.fixtures.agent.assert('degrade', { screenshot: false });
    expect(fakeCalls[0]!.images).toHaveLength(0);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    await expect(session.fixtures.agent.assert('strict', { vision: 'only', screenshot: false })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(fakeCalls).toHaveLength(1);
    await session.close();
  });

  it('requires custom capability opt-in for per-call policies and preserves legacy inputs', async () => {
    const received: unknown[] = [];
    const executor: StepExecutor = { name: 'custom', runStep: async (context) => { received.push(context.step); return { status: 'passed', summary: 'done' }; } };
    const { session } = await open({ agents: { default: { executor } } });
    await session.fixtures.agent.act('legacy');
    expect(received[0]).not.toHaveProperty('observation');
    await expect(session.fixtures.agent.act('policy', { observation: 'tree-only' })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(received).toHaveLength(1);
    await session.close();
  });

  it.each([false, true, 'only'] as const)('rejects per-call vision=%s on an incapable custom executor', async (vision) => {
    let dispatches = 0;
    const executor: StepExecutor = { name: 'incapable', runStep: async () => { dispatches++; return { status: 'passed', summary: 'done' }; } };
    const { session } = await open({ agents: { default: { executor } } });
    await expect(session.fixtures.agent.assert('vision', { vision, screenshot: false })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' });
    expect(dispatches).toBe(0);
    await session.close();
  });

  it('declared custom capabilities receive resolved defaults and call overrides', async () => {
    const received: { kind: string; observation?: string; vision?: boolean | 'only' }[] = [];
    const executor: StepExecutor = { name: 'custom', observationPolicy: true, vision: true, runStep: async (context) => { received.push(context.step); return { status: 'passed', summary: 'done' }; } };
    const { session } = await open({ agents: { default: { executor, observationPolicy: { act: 'tree+pixels', judgments: true } } } });
    await session.fixtures.agent.act('configured');
    await session.fixtures.agent.act('override', { observation: 'tree-only' });
    await session.fixtures.agent.assert('configured', { screenshot: false });
    await session.fixtures.agent.assert('override', { vision: false, screenshot: false });
    expect(received.map((step) => [step.observation, step.vision])).toEqual([
      ['tree+pixels', undefined], ['tree-only', undefined], [undefined, true], [undefined, undefined],
    ]);
    await session.close();
  });
});
