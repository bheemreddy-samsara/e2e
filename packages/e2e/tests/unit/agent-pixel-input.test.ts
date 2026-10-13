/** Tests the request boundary itself, including non-degradable observations. */
import { describe, expect, it } from 'vitest';
import { asSdkLanguageModel, loadAiSdk } from '../../src/agent/ai-sdk.ts';
import { withSafePixelInput, type PixelInputPolicy } from '../../src/agent/model/pixel-input.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

const prompt = [{ role: 'user', content: [
  { type: 'text', text: 'current semantic tree' },
  { type: 'file', mediaType: 'image/png', data: { type: 'data', data: new Uint8Array(8) } },
] }];
type Request = { prompt: typeof prompt; abortSignal?: AbortSignal };
const reply = () => scriptedResult([{ type: 'text', text: 'ok' }], 'stop');

async function harness(generate: (request: Request) => Promise<object>, overrides: Partial<PixelInputPolicy> = {}) {
  const ai = await loadAiSdk();
  const events: Parameters<PixelInputPolicy['record']>[0][] = [];
  let rejected = 0, retries = 0;
  const model = withSafePixelInput(ai, asSdkLanguageModel(createScriptedInstance('synthetic', 'pixels', generate)), {
    permitted: () => true, canDegrade: () => true,
    record: (input) => events.push(input),
    rejected: () => { rejected++; },
    retry: () => { retries++; },
    ...overrides,
  });
  return { request: (options: Request = { prompt }) => model.doGenerate(options as never), events, counts: () => ({ rejected, retries }) };
}

describe('safe model pixel boundary', () => {
  it.each([
    'Unsupported image format. Upload a PNG or JPEG image.',
    'Unsupported image input format',
    'Unsupported image input type',
    'Unsupported image input size',
    'Unsupported image payload data encoding',
    'Unsupported image input operation',
  ])('does not mistake %s for unsupported image capability', async (message) => {
    let calls = 0;
    const h = await harness(async () => {
      if (++calls === 1) throw Object.assign(new Error(message), { statusCode: 400 });
      return reply();
    });
    await expect(h.request()).rejects.toThrow(message);
    await h.request();
    expect(h.events).toEqual([{ bytes: 8, peakBytes: 8 }]);
    expect(h.counts()).toEqual({ rejected: 0, retries: 0 });
  });

  it('accounts rejected requests before refusing to degrade an unavailable tree', async () => {
    const h = await harness(async () => { throw Object.assign(new Error('model does not support images'), { statusCode: 400 }); }, { canDegrade: () => false });
    await expect(h.request()).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(h.counts()).toEqual({ rejected: 1, retries: 0 });
    expect(h.events).toEqual([{ degraded: 'MODEL_IMAGES_UNSUPPORTED' }]);
  });

  it('remembers a genuine capability rejection and strips images on following requests', async () => {
    const images: number[] = [];
    const h = await harness(async (request) => {
      images.push(request.prompt.flatMap((message) => message.content).filter((part) => part.type === 'file').length);
      if (images.length === 1) throw Object.assign(new Error('image input is not supported'), { statusCode: 422 });
      return reply();
    });
    await h.request();
    await h.request();
    expect(images).toEqual([1, 0, 0]);
    expect(h.counts()).toEqual({ rejected: 1, retries: 1 });
    expect(h.events.every((event) => event.bytes === undefined)).toBe(true);
  });

  it('accounts a failed text-only replacement without counting it on success', async () => {
    let requests = 0;
    const h = await harness(async () => {
      if (++requests === 1) throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
      throw new Error('replacement failed');
    });
    await expect(h.request()).rejects.toThrow('replacement failed');
    expect(requests).toBe(2);
    expect(h.counts()).toEqual({ rejected: 2, retries: 1 });
  });

  it('does not retry an aborted image rejection', async () => {
    const abort = new AbortController();
    const h = await harness(async () => { abort.abort(); throw Object.assign(new Error('model does not support images'), { statusCode: 400 }); });
    await expect(h.request({ prompt, abortSignal: abort.signal })).rejects.toThrow('does not support');
    expect(h.counts()).toEqual({ rejected: 0, retries: 0 });
  });

  it('records ignored-image warnings without reporting accepted pixels', async () => {
    const h = await harness(async () => scriptedResult([{ type: 'text', text: 'tree answer' }], 'stop', [{ type: 'unsupported', feature: 'image input' }]));
    await h.request();
    expect(h.events).toEqual([{ degraded: 'MODEL_IMAGES_UNSUPPORTED' }]);
  });

  it('preflights an image-rejection replacement and does not charge a request that never left', async () => {
    let requests = 0, preflights = 0;
    const h = await harness(async () => { requests++; throw Object.assign(new Error('model does not support images'), { statusCode: 400 }); }, {
      preflight: () => { if (++preflights === 2) throw new Error('replacement input exceeds budget'); },
    });
    await expect(h.request()).rejects.toThrow('replacement input exceeds budget');
    expect(requests).toBe(1);
    expect(preflights).toBe(2);
    expect(h.counts()).toEqual({ rejected: 1, retries: 1 });
  });

  it('checks the replacement request budget before calling the provider again', async () => {
    let requests = 0;
    const h = await harness(async () => { requests++; throw Object.assign(new Error('model does not support images'), { statusCode: 400 }); }, { retry: () => { throw new Error('budget exhausted'); } });
    await expect(h.request()).rejects.toThrow('budget exhausted');
    expect(requests).toBe(1);
    expect(h.counts().rejected).toBe(1);
  });

  it.each(['PIXEL_TAINTED', 'known', 'rejected', 'ignored'] as const)('preserves unrelated content results during %s history fallback', async (mode) => {
    const ai = await loadAiSdk();
    const unrelated = { type: 'tool-result' as const, toolCallId: 'text', toolName: 'read_text',
      output: { type: 'content' as const, value: [{ type: 'text' as const, text: 'original unrelated result' }] } };
    const file = { type: 'file' as const, mediaType: 'image/png', data: { type: 'data' as const, data: new Uint8Array(8) } };
    const affected = { type: 'tool-result' as const, toolCallId: 'image', toolName: 'screenshot',
      output: { type: 'content' as const, value: [{ type: 'text' as const, text: 'original screenshot result' }, file] } };
    const original = structuredClone(unrelated);
    const history = [{ role: 'user' as const, content: [file] }, { role: 'tool' as const, content: [unrelated, affected] }];
    const requests: import('@ai-sdk/provider').LanguageModelV4CallOptions[] = [];
    const model = withSafePixelInput(ai, asSdkLanguageModel(createScriptedInstance<import('@ai-sdk/provider').LanguageModelV4CallOptions>('synthetic', 'mixed', async (request) => {
      requests.push(request);
      if (mode === 'rejected' && requests.length === 1) throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
      return mode === 'ignored' && requests.length === 1 ? scriptedResult([{ type: 'text', text: 'ok' }], 'stop', [{ type: 'unsupported', feature: 'image input' }]) : reply();
    })), { supported: mode === 'known' ? false : undefined, permitted: () => mode !== 'PIXEL_TAINTED', canDegrade: () => true, record: () => {}, rejected: () => {} });
    if (model.specificationVersion !== 'v4') throw new Error('expected a V4 model wrapper');
    await model.doGenerate({ prompt: history });
    if (mode === 'ignored') await model.doGenerate({ prompt: history });
    const replacement = requests.at(-1)!;
    const toolMessage = replacement.prompt[1]!;
    expect(toolMessage.content[0]).toEqual(original);
    expect(toolMessage.content[0]).toBe(unrelated);
    expect(unrelated).toEqual(original);
    expect(toolMessage.content[1]).toMatchObject({ output: { value: [
      { type: 'text', text: 'original screenshot result' },
      { type: 'text', text: expect.stringContaining('Screenshots withheld') },
    ] } });
    expect(replacement.prompt[0]).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('Screenshot withheld') }] });
    expect(requests).toHaveLength(mode === 'rejected' || mode === 'ignored' ? 2 : 1);
  });
});
