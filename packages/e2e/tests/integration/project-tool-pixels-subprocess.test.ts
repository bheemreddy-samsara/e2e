/** Public built SDK smoke: synthetic engine and provider, no credentials or device. */
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('public project tool pixel refresh', () => {
  it.each(['string', 'structured', 'custom', 'failure', 'late-failure', 'tree-only', 'adaptive', 'read-only'])('preserves %s and reports actual transport evidence', (mode) => {
    const runner = new URL('../../dist/runner.js', import.meta.url).href;
    const engine = new URL('../../dist/engine/index.js', import.meta.url).href;
    const agent = new URL('../../dist/agent/public.js', import.meta.url).href;
    const source = String.raw`
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { z } from 'zod';
      import { openHost } from ${JSON.stringify(runner)};
      import { defineEngine } from ${JSON.stringify(engine)};
      import { defineTool, getToolContext } from ${JSON.stringify(agent)};
      const mode = ${JSON.stringify(mode)};
      const cwd = mkdtempSync(join(tmpdir(), 'e2e-project-pixels-'));
      const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jdp8AAAAASUVORK5CYII=', 'base64');
      const opted = !['tree-only', 'adaptive', 'read-only'].includes(mode);
      let revision = 1, executions = 0, captures = 0, models = 0;
      let firstRevision;
      const surface = defineEngine({
        name: 'synthetic-public', version: '1', spiVersion: 1,
        observe: async (_operation, options) => ({
          root: { ref: { id: 'n1', revision: '' }, role: 'button', name: revision === 1 ? 'Before' : 'After' },
          viewport: { width: 100, height: 100 },
          ...(options?.pixels ? (captures++, { pixels: { data: Buffer.concat([png, Buffer.from([revision])]), mediaType: 'image/png', width: 1, height: 1, scale: 1 }, maskedRegionCount: 0 }) : {}),
        }),
        dispose: async () => {},
      });
      const result = mode === 'string' ? 'ordinary result' : { committed: true };
      const mutation = defineTool({
        description: 'change synthetic screen', inputSchema: z.object({}),
        execute: async (_input, options) => {
          executions++;
          if (mode !== 'read-only') {
            assert.throws(() => getToolContext(options).observe(), /only read-only/);
            if (mode === 'late-failure') setTimeout(() => { revision = 2; }, 250);
            else revision = 2;
          }
          if (['failure', 'late-failure'].includes(mode)) throw new Error('uncertain connection loss');
          return result;
        },
        ...(mode === 'custom' ? { toModelOutput: ({ output }) => { assert.equal(output, result); return { type: 'text', value: 'CUSTOM OUTPUT' }; } } : {}),
      }, { mutates: mode !== 'read-only' });
      const images = prompt => prompt.flatMap(message => typeof message.content === 'string' ? [] : message.content.flatMap(part =>
        part.type === 'file' ? [part] : part.type === 'tool-result' && part.output.type === 'content' ? part.output.value.filter(item => item.type === 'file') : []));
      const text = message => typeof message.content === 'string' ? message.content : message.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
      const model = {
        specificationVersion: 'v4', provider: 'synthetic', modelId: 'project-tool-smoke', supportedUrls: {},
        async doGenerate(options) {
          models++;
          const users = options.prompt.filter(message => message.role === 'user');
          if (models === 1) {
            firstRevision = /revision (\S+?)[,)]/.exec(text(users[0]))[1];
          } else {
            const output = options.prompt.findLast(message => message.role === 'tool').content[0].output;
            if (['failure', 'late-failure'].includes(mode)) assert.match(output.value, /uncertain connection loss/);
            else if (mode === 'custom') assert.equal(output.value, 'CUSTOM OUTPUT');
            else if (mode === 'string') assert.equal(output.value, result);
            else assert.deepEqual(output.value, result);
            if (opted) {
              const latest = users.at(-1);
              assert.match(text(latest), /After/);
              assert.ok(!text(latest).includes('Current screen (revision ' + firstRevision + ','));
              const pixel = images([latest]).at(-1);
              assert.ok(pixel, 'next turn needs a fresh screenshot');
              assert.equal(Buffer.from(pixel.data.data).at(-1), 2);
              if (['failure', 'late-failure'].includes(mode)) assert.match(text(latest), /may have committed/);
            } else assert.equal(users.length, 1);
          }
          return { content: [{ type: 'tool-call', toolCallId: 'call-' + models,
            toolName: models === 1 ? 'mutation' : 'complete_step', input: JSON.stringify(models === 1 ? {} : { status: 'passed', summary: 'verified' }) }],
            finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
            usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } }, warnings: [] };
        }, async doStream() { throw new Error('not used'); },
      };
      let host;
      try {
        host = await openHost({ cwd, env: {}, config: {
          targets: [{ name: 'surface', platform: 'synthetic', engine: surface }], cache: 'off',
          agents: { visual: { model, tools: { mutation }, maxSteps: 1, maxModelCalls: 4, observationPolicy: { act: 'tree+pixels' } } },
        } });
        const session = await host.openSession({ name: 'project-tool-policy', agent: 'visual' });
        const acted = await session.fixtures.agent.act('mutate and verify', ['tree-only', 'adaptive'].includes(mode) ? { observation: mode } : undefined);
        const step = session.steps()[0];
        assert.equal(executions, 1);
        assert.equal(acted.actions, mode === 'read-only' ? 0 : 1);
        assert.equal(acted.modelCalls, 2);
        assert.equal(models, 2);
        assert.equal(step.model.inputTokens, 200);
        assert.equal(step.metrics.modelImageBytes > 0, !['tree-only', 'adaptive'].includes(mode));
        if (opted) assert.ok(step.metrics.modelImageBytes >= (png.length + 1) * 2);
        if (['tree-only', 'adaptive'].includes(mode)) assert.equal(captures, 0);
        await session.close();
        console.log(JSON.stringify({ mode, executions, actions: acted.actions, models, captures, modelImageBytes: step.metrics.modelImageBytes, synthetic: true }));
      } finally { await host?.close(); rmSync(cwd, { recursive: true, force: true }); }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 20_000 });
    expect(result.status, result.stderr + result.stdout).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toMatchObject({ mode, executions: 1, models: 2, synthetic: true });
  });
});
