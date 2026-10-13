/** Final prepared request estimates, not live provider token billing. */
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { asSdkLanguageModel, loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { bindPixelRequestBudget, pixelRequestPreflight } from '../../src/agent/model/pixel-request-budget.ts';
import { withSafePixelInput } from '../../src/agent/model/pixel-input.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

const data = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64'));
const image = { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data } };
const request: LanguageModelV4CallOptions = {
  prompt: [
    { role: 'system', content: 'trusted instructions and project context' },
    { role: 'user', content: [{ type: 'text', text: 'instruction and ledger and tree' }, image] },
  ],
  tools: [{ type: 'function', name: 'peek', description: 'project tool schema', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } }],
  toolChoice: { type: 'auto' },
  providerOptions: { synthetic: { guidance: 'provider hint' } },
};

/** An independent expected byte-scaled input serialization, plus the documented per-image reserve. */
function expected(input: LanguageModelV4CallOptions, images: number): number {
  return Buffer.byteLength(JSON.stringify({ prompt: input.prompt, tools: input.tools, toolChoice: input.toolChoice, responseFormat: input.responseFormat, providerOptions: input.providerOptions },
    (_key, value: unknown) => value instanceof Uint8Array ? Buffer.from(value).toString('base64') : value)) + images * 4_784;
}

async function boundary(limit: number, permitted = true) {
  const context = {} as never;
  bindPixelRequestBudget(context, limit, (error) => error);
  let calls = 0;
  const events: unknown[] = [];
  const model = withSafePixelInput(await loadAiSdk(), asSdkLanguageModel(createScriptedInstance('synthetic', 'ceiling', async () => {
    calls++;
    return scriptedResult([{ type: 'text', text: 'ok' }], 'stop');
  })), {
    preflight: pixelRequestPreflight(context), permitted: () => permitted, canDegrade: () => true,
    record: (input) => events.push(input), rejected: () => {},
  });
  return { send: (input = request) => model.doGenerate(input as never), calls: () => calls, events };
}

describe('opt-in pixel request ceiling', () => {
  it('leaves unbound default and legacy executor contexts alone', () => {
    expect(pixelRequestPreflight({} as never)).toBeUndefined();
  });

  it('counts final instructions, context, tool schemas, provider hints and image input at the ceiling', async () => {
    const bound = expected(request, 1);
    const refused = await boundary(bound - 1);
    await expect(refused.send()).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED', message: `model input upper bound ${bound} exceeds the agent's maxInputTokens ${bound - 1}` });
    expect(refused.calls()).toBe(0);
    expect(refused.events).toEqual([]);
    const fits = await boundary(bound);
    await fits.send();
    expect(fits.calls()).toBe(1);
    expect(fits.events).toEqual([{ bytes: data.length, peakBytes: data.length }]);
  });

  it('charges duplicate and retained tool-result images, calls, reasoning and results on each request', async () => {
    const next: LanguageModelV4CallOptions = { ...request, prompt: [...request.prompt,
      { role: 'assistant', content: [{ type: 'reasoning', text: 'earlier reasoning' }, { type: 'tool-call', toolCallId: 'peek-1', toolName: 'peek', input: '{"value":"earlier input"}' }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'peek-1', toolName: 'peek', output: { type: 'content', value: [{ type: 'text', text: 'new tree' }, image, image] } }] },
    ] };
    const h = await boundary(expected(next, 3) - 1);
    await h.send();
    await expect(h.send(next)).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(h.calls()).toBe(1);
    expect(h.events).toHaveLength(1);
  });

  it('does not treat a tiny encoded file or a dimension cap as the whole request budget', async () => {
    const h = await boundary(1);
    await expect(h.send()).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(h.calls()).toBe(0);
  });

  it('charges larger encoded PNG geometry even when declared viewports or compression are small', async () => {
    const large = data.slice();
    new DataView(large.buffer).setUint32(16, 10_000);
    new DataView(large.buffer).setUint32(20, 10_000);
    const h = await boundary(50_000);
    await expect(h.send({ prompt: [{ role: 'user', content: [{ ...image, data: { type: 'data', data: large } }] }] })).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(h.calls()).toBe(0);
  });

  it('refuses unmeasurable non-inline images without fetching them or dispatching transport', async () => {
    const h = await boundary(1_000_000);
    await expect(h.send({ prompt: [{ role: 'user', content: [{ ...image, data: { type: 'url', url: new URL('https://example.test/image.png') } }] }] })).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(h.calls()).toBe(0);
  });

  it('checks the degraded final request rather than denying an explicitly permitted tree-only replacement for image cost', async () => {
    const h = await boundary(expected(request, 0) + 100, false);
    await h.send();
    expect(h.calls()).toBe(1);
    expect(h.events).toEqual([{ degraded: 'PIXEL_TAINTED' }]);
  });

  it('still refuses a degraded request whose text and tools cannot fit', async () => {
    const h = await boundary(1, false);
    await expect(h.send()).rejects.toMatchObject({ code: 'STEP_BUDGET_EXHAUSTED' });
    expect(h.calls()).toBe(0);
    expect(h.events).toEqual([{ degraded: 'PIXEL_TAINTED' }]);
  });
});
