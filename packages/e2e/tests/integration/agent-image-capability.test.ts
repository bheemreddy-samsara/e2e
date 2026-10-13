/** Changed-screen waitFor through the built hosted SDK, using synthetic models only. */
import { describe, expect, it } from 'vitest';
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

const data = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64'));
describe('judgment discovered image capability', { timeout: 60_000 }, () => {
  const { host, config } = hostHarness();
  async function run(mode: 'known' | 'rejected' | 'ignored') {
    let captures = 0;
    const requests: { images: number; text: string }[] = [];
    const tree = { ref: { id: 'root', revision: '' }, role: 'button', name: 'Initial',
      children: Array.from({ length: 500 }, (_, i) => ({ ref: { id: 'child' + i, revision: '' }, role: 'button', name: 'Label ' + i + ' ' + 'x'.repeat(80) })) };
    const fake = createFakeEngine({ tree, pixels: () => { captures++; return { pixels: { data, mediaType: 'image/png', width: 1, height: 1, scale: 1 } }; } });
    const model = { ...createScriptedInstance<LanguageModelV4CallOptions>('synthetic', mode, async (request) => {
      let images = 0;
      const text: string[] = [];
      for (const message of request.prompt) {
        if (typeof message.content === 'string') continue;
        for (const part of message.content) {
          if (part.type === 'file') images++;
          if (part.type === 'text') text.push(part.text);
        }
      }
      requests.push({ images, text: text.join('\n') });
      if (mode === 'rejected' && requests.length === 1) throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
      const first = requests.length === (mode === 'rejected' ? 2 : 1);
      tree.name = 'Changed';
      return scriptedResult([{ type: 'text', text: JSON.stringify({ protocolVersion: 'agent-judgment-2', verdict: first ? 'fails' : 'holds', explanation: 'synthetic' }) }], 'stop',
        mode === 'ignored' && first ? [{ type: 'unsupported', feature: 'image input' }] : []);
    }), ...(mode === 'known' ? { supportsImageInput: false } : {}) };
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: 'off', agents: { default: { model, maxInputTokens: 12_000, maxModelCalls: 4, observationPolicy: { judgments: true } } } }) });
    const session = await opened.openSession({ name: mode });
    await session.fixtures.agent.waitFor('changed', { interval: 100 });
    const step = session.steps()[0]!;
    expect(fake.callsOf(session.attemptId, 'perform')).toHaveLength(0);
    expect(step.metrics!.modelCalls).toBe(requests.length);
    expect(step.visionDegraded).toBe('MODEL_IMAGES_UNSUPPORTED');
    expect(step.visionInput).toBeUndefined();
    await session.close();
    await opened.close();
    return { captures, requests };
  }
  it.each(['rejected', 'ignored'] as const)('stops optional captures and restores semantic budget after %s', async (mode) => {
    const discovered = await run(mode), known = await run('known');
    expect(discovered.requests.map((request) => request.images)).toEqual(mode === 'rejected' ? [1, 0, 0] : [1, 0]);
    expect(discovered.captures).toBe(1);
    expect(discovered.requests.at(-1)!.text).toBe(known.requests.at(-1)!.text);
    expect(discovered.requests.at(-1)!.text).toContain('Changed');
  });

  it.each(['rejected', 'ignored'] as const)('keeps pixels-only judgment strict after %s capability loss', async (mode) => {
    let transports = 0;
    const fake = createFakeEngine({ pixels: () => ({ pixels: { data, mediaType: 'image/png', width: 1, height: 1, scale: 1 } }) });
    const model = createScriptedInstance('synthetic', 'strict', async () => {
      transports++;
      if (mode === 'rejected') throw Object.assign(new Error('model does not support images'), { statusCode: 400 });
      return scriptedResult([{ type: 'text', text: JSON.stringify({ protocolVersion: 'agent-judgment-2', verdict: 'holds', explanation: 'ignored pixels' }) }], 'stop', [{ type: 'unsupported', feature: 'image input' }]);
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { cache: 'off', agents: { default: { model } } }) });
    const session = await opened.openSession({ name: 'strict' });
    await expect(session.fixtures.agent.assert('pixels only', { vision: 'only', screenshot: false })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(transports).toBe(1);
    expect(session.steps()[0]!.metrics!.modelCalls).toBe(1);
    expect(session.steps()[0]!.visionInput).toBeUndefined();
    expect(session.steps()[0]!.visionDegraded).toBe('MODEL_IMAGES_UNSUPPORTED');
    await session.close();
  });
});
