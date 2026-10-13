/** Runs only built public SDK imports in a fresh consumer process, with no credentials. */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hosted safe pixels: public SDK subprocess', () => {
  it('refuses a minimal tree plus real PNG before synthetic transport when maxInputTokens is one', () => {
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    const engine = new URL('../../dist/engine/index.js', import.meta.url).href;
    const source = `
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { openHost } from ${JSON.stringify(runner)};
      import { defineEngine } from ${JSON.stringify(engine)};
      const cwd = mkdtempSync(join(tmpdir(), 'e2e-public-pixel-budget-'));
      const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64');
      let requests = 0;
      const surface = defineEngine({
        name: 'synthetic-budget', version: '1', spiVersion: 1,
        observe: async (_operation, options) => ({
          root: { ref: { id: 'n1', revision: '' }, role: 'button', name: 'Go' },
          viewport: { width: 1, height: 1 },
          ...(options?.pixels ? { pixels: { data, mediaType: 'image/png', width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 } : {}),
        }),
      });
      const model = {
        specificationVersion: 'v4', provider: 'synthetic', modelId: 'budget', supportedUrls: {},
        async doGenerate() {
          requests++;
          return { content: [{ type: 'tool-call', toolCallId: 'done', toolName: 'complete_step',
            input: JSON.stringify({ status: 'passed', summary: 'saw Go' }) }],
            finishReason: { unified: 'tool-calls', raw: 'stop' },
            usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [] };
        },
        async doStream() { throw new Error('not used'); },
      };
      let host;
      try {
        host = await openHost({ cwd, env: {}, config: {
          targets: [{ name: 'surface', platform: 'synthetic', engine: surface }], cache: 'off',
          agents: { default: { model, maxInputTokens: 1, observationPolicy: { act: 'tree+pixels' } } },
        } });
        const session = await host.openSession({ name: 'minimal-budget' });
        await assert.rejects(session.fixtures.agent.act('observe Go'), { code: 'STEP_BUDGET_EXHAUSTED' });
        assert.equal(requests, 0);
        const step = session.steps()[0];
        assert.equal(step.metrics.modelCalls, 0);
        assert.equal(step.metrics.modelImageBytes, undefined);
        assert.equal(step.visionInput, undefined);
        await session.close();
        console.log(JSON.stringify({ requests, synthetic: true }));
      } finally {
        await host?.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ requests: 0, synthetic: true });
  });

  it('inherits a named-agent policy and reports real transport inputs, refresh, and overrides', () => {
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    const engine = new URL('../../dist/engine/index.js', import.meta.url).href;
    const source = `
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { openHost } from ${JSON.stringify(runner)};
      import { defineEngine } from ${JSON.stringify(engine)};
      const cwd = mkdtempSync(join(tmpdir(), 'e2e-public-pixels-'));
      const data = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64');
      let taps = 0, models = 0, disposes = 0;
      const inputs = [];
      const surface = defineEngine({
        name: 'synthetic-public', version: '1', spiVersion: 1,
        actions: ['tap'],
        perform: async () => { taps++; },
        observe: async (_operation, options) => ({
          root: { ref: { id: 'n1', revision: '' }, role: 'button', name: taps ? 'Done' : 'Go' },
          viewport: { width: 100, height: 100 },
          ...(options?.pixels ? { pixels: { data, mediaType: 'image/png', width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 } : {}),
        }),
        dispose: async () => { disposes++; },
      });
      const model = {
        specificationVersion: 'v4', provider: 'synthetic', modelId: 'public-smoke', supportedUrls: {},
        async doGenerate(options) {
          models++;
          const images = options.prompt.flatMap(message => typeof message.content === 'string' ? [] : message.content.flatMap(part =>
            part.type === 'file' ? [part] : part.type === 'tool-result' && part.output.type === 'content' ? part.output.value.filter(item => item.type === 'file') : []));
          inputs.push(images.length);
          const content = options.tools?.length ?
            [{ type: 'tool-call', toolCallId: 'call-' + models, toolName: taps ? 'complete_step' : 'tap',
              input: JSON.stringify(taps ? { status: 'passed', summary: 'observed done' } : { target: 'n1' }) }] :
            [{ type: 'text', text: JSON.stringify({ protocolVersion: 'agent-judgment-2', verdict: 'holds', explanation: 'done' }) }];
          return { content, finishReason: { unified: options.tools?.length ? 'tool-calls' : 'stop', raw: 'stop' },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
        },
        async doStream() { throw new Error('not used'); },
      };
      let host;
      try {
        host = await openHost({ cwd, env: {}, config: {
          targets: [{ name: 'surface', platform: 'synthetic', engine: surface }],
          cache: 'off', agents: { visual: { model, observationPolicy: { act: 'tree+pixels', judgments: true } } },
        } });
        const session = await host.openSession({ name: 'public-policy', agent: 'visual' });
        const acted = await session.fixtures.agent.act('tap Go and verify Done');
        await session.fixtures.agent.assert('Done', { vision: false, screenshot: false });
        const steps = session.steps();
        assert.equal(taps, 1);
        assert.equal(acted.modelCalls, 2);
        assert.equal(inputs[0], 1);
        assert.ok(inputs[1] > 0);
        assert.equal(inputs[2], 0);
        assert.equal(steps[0].visionInput, true);
        assert.ok(steps[0].metrics.modelImageBytes >= data.length * 2);
        assert.equal(steps[1].visionInput, undefined);
        assert.deepEqual(await session.close(), []);
        assert.deepEqual(await session.close(), []);
        assert.deepEqual(await host.close(), []);
        assert.equal(disposes, 1);
        console.log(JSON.stringify({ inputs, taps, modelCalls: models, imageBytes: steps[0].metrics.modelImageBytes, teardown: 'idempotent', synthetic: true }));
      } finally {
        await host?.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const evidence = JSON.parse(result.stdout.trim());
    expect(evidence).toMatchObject({ taps: 1, modelCalls: 3, teardown: 'idempotent', synthetic: true });
    expect(evidence.imageBytes).toBeGreaterThan(0);
  });
});
