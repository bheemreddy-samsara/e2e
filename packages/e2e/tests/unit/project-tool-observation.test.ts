/** Scripted provider regressions: no screenshot tool call, no live device/model. */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Tool, ToolExecutionOptions } from 'ai';
import type { ModelInstance } from '../../src/types.ts';
import { createBuiltInAgent, projectTools } from '../../src/agent/default-agent.ts';
import { defineTool, getToolContext } from '../../src/agent/tool.ts';
import { AgentError } from '../../src/agent/error.ts';
import type { ExecutorObservation, StepExecutorContext } from '../../src/agent/executor.ts';
import { fakeExecutorContext } from '../helpers/fake-executor-context.ts';
import { installFakeLoopModel, loopCalls } from '../helpers/fake-loop-model.ts';

const done = [{ toolName: 'complete_step', input: { status: 'passed', summary: 'done' } }];
const executionOptions = { toolCallId: 'direct', messages: [], context: undefined } satisfies ToolExecutionOptions<unknown>;

/** Records the exact provider request while retaining the scripted loop. */
function transport(model: ModelInstance) {
  const requests: string[] = [];
  const generate = model.doGenerate as (options: { prompt: unknown }) => Promise<unknown>;
  return { requests, model: { ...model, doGenerate: async (options: { prompt: unknown }) => {
    requests.push(JSON.stringify(options.prompt));
    return generate(options);
  } } as ModelInstance };
}

/** One synthetic mutation changes both tree revision and image bytes. */
function rig(mode: 'tree+pixels' | 'tree-only' | 'adaptive' | undefined, mutates = true, failure = false) {
  let revision = 1;
  let tainted = false;
  let withheld: ExecutorObservation['pixelsWithheld'];
  let observeFailure = false;
  let actions = 0;
  const requests: unknown[] = [];
  const result = { committed: true, revision: 2 };
  const execute = vi.fn(async (_input: unknown, execution: ToolExecutionOptions<unknown>) => {
    if (mutates) {
      expect(() => getToolContext(execution).observe()).toThrow(/only read-only/);
      revision = 2;
    }
    if (failure) throw new Error('connection lost after dispatch');
    return result;
  });
  const toModelOutput = vi.fn(({ output }: { output: unknown }) => ({ type: 'text' as const, value: `custom:${JSON.stringify(output)}` }));
  const tool = defineTool({ description: 'change synthetic screen', inputSchema: z.object({}), execute, toModelOutput } as Tool, { mutates });
  const fake = fakeExecutorContext();
  const context: StepExecutorContext = {
    ...fake.context,
    step: { ...fake.context.step, ...(mode === undefined ? {} : { observation: mode }) },
    get pixelsTainted() { return tainted; },
    budgets: { ...fake.context.budgets, runTool: async (call, body) => { if (call.mutates) actions++; return body(); } },
    observe: async (options) => {
      requests.push(options);
      if (observeFailure && revision === 2) throw new AgentError('STEP_TIMEOUT', 'fresh evidence timed out');
      return { revision: `r${revision}`, text: `#n1 button "${revision === 1 ? 'Before' : 'After'}"`, truncated: false, viewport: { width: 10, height: 10 },
        ...(options?.pixels ? tainted || withheld !== undefined ? { pixelsWithheld: tainted ? 'PIXEL_TAINTED' as const : withheld! } : { pixels: { data: new Uint8Array([revision, 80, 78, 71]), mediaType: 'image/png' as const, width: 1, height: 1, scale: 1, maskedRegionCount: 0 } } : {}),
      };
    },
  };
  const wire = transport(installFakeLoopModel((call) => call.turn === 1 ? [{ toolName: 'change', input: {} }] : done));
  return { context: { ...context, model: wire.model, get pixelsTainted() { return tainted; } }, tool, execute, toModelOutput, result, requests, wire,
    actions: () => actions, taint: () => { tainted = true; }, withhold: (reason: NonNullable<typeof withheld>) => { withheld = reason; }, failObserve: () => { observeFailure = true; } };
}

describe('opt-in project tool evidence', () => {
  it('refreshes revision and image before the next request, retaining the custom model output', async () => {
    const r = rig('tree+pixels');
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context);
    expect(r.requests).toEqual([{ pixels: true }, { pixels: true }]);
    expect(loopCalls[1]!.lastPrompt).toContain('revision r2');
    expect(loopCalls[1]!.lastPrompt).toContain('After');
    expect(r.wire.requests[0]).toContain('"0":1');
    expect(r.wire.requests[1]).toContain('"0":2');
    const newest = JSON.parse(r.wire.requests[1]!) as { role: string; content: unknown }[];
    expect(JSON.stringify(newest.at(-1)!.content)).toContain('"0":2');
    expect(JSON.stringify(newest.at(-1)!.content)).not.toContain('"0":1');
    expect(loopCalls[1]!.lastToolResult).toBe('custom:{"committed":true,"revision":2}');
    expect(r.toModelOutput.mock.calls[0]![0].output).toBe(r.result);
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.actions()).toBe(1);
    expect(loopCalls).toHaveLength(2);
  });

  it.each([undefined, 'adaptive', 'tree-only'] as const)('does not refresh or add pixel captures for %s', async (mode) => {
    const r = rig(mode);
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context);
    expect(r.requests).toEqual([undefined]);
    expect(loopCalls[1]!.imageParts).toBe(0);
    expect(r.execute).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a read-only project tool', async () => {
    const r = rig('tree+pixels', false);
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context);
    expect(r.requests).toEqual([{ pixels: true }]);
    expect(r.actions()).toBe(0);
  });

  it('refreshes an uncertain failed mutation without repeating it', async () => {
    const r = rig('tree+pixels', true, true);
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context);
    expect(loopCalls[1]!.lastToolResult).toContain('connection lost');
    expect(loopCalls[1]!.lastPrompt).toContain('may have committed');
    expect(loopCalls[1]!.lastPrompt).toContain('revision r2');
    expect(r.wire.requests[1]).toContain('"0":2');
    expect(r.execute).toHaveBeenCalledTimes(1);
    expect(r.actions()).toBe(1);
  });

  it('never sends a stale request if the refresh fails', async () => {
    const r = rig('tree+pixels');
    r.failObserve();
    await expect(createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context)).rejects.toMatchObject({ code: 'STEP_TIMEOUT' });
    expect(r.wire.requests).toHaveLength(1);
    expect(r.execute).toHaveBeenCalledTimes(1);
  });

  it('does not refresh a mutation refused by its action budget', async () => {
    const r = rig('tree+pixels');
    const context = { ...r.context, budgets: { ...r.context.budgets, runTool: async (): Promise<never> => { throw new AgentError('STEP_BUDGET_EXHAUSTED', 'no actions left'); } } };
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(context);
    expect(r.execute).not.toHaveBeenCalled();
    expect(r.requests).toEqual([{ pixels: true }]);
  });

  it.each(['PIXEL_TAINTED', 'MASKING_UNPROVEN', 'UNSUPPORTED_CAPABILITY', 'MODEL_IMAGES_UNSUPPORTED'] as const)('uses fresh tree and reports %s without new image bytes', async (reason) => {
    const r = rig('tree+pixels');
    const run = r.execute.getMockImplementation()!;
    r.execute.mockImplementation(async (input, options) => {
      const result = await run(input, options);
      if (reason === 'PIXEL_TAINTED') r.taint(); else r.withhold(reason);
      return result;
    });
    await createBuiltInAgent({ tools: { change: r.tool } }).runStep(r.context);
    expect(loopCalls[1]!.lastPrompt).toContain('revision r2');
    expect(loopCalls[1]!.lastPrompt).toContain(reason);
    expect(r.wire.requests[1]).not.toContain('"0":2');
    if (reason === 'PIXEL_TAINTED') expect(loopCalls[1]!.imageParts).toBe(0);
  });

  it.each(['short result', { structured: true }, 42])('preserves the direct execute result contract (%j)', async (value) => {
    const r = rig('tree+pixels');
    const defined = defineTool({ description: 'result contract', inputSchema: z.object({}), execute: async () => value } as Tool, { mutates: true });
    const wrapped = projectTools(r.context, { change: defined }).change!;
    expect(await wrapped.execute!({} as never, executionOptions)).toBe(value);
    expect(r.requests).toEqual([]);
  });
});
