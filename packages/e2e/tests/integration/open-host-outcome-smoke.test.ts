/** Subprocess consumer of built public entry points, using synthetic transport, never a native device. */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('hosted external outcome public SDK smoke', () => {
  it('works outside the test process with no model or native device', () => {
    const script = `
      import assert from 'node:assert/strict';
      import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import path from 'node:path';
      import { openHost } from 'e2e/runner';
      import { expect as sdkExpect } from 'e2e';
      import { defineEngine, ENGINE_SPI_VERSION } from 'e2e/engine';

      const events = [];
      const engine = defineEngine({
        name: 'synthetic-transport', version: '1.0.0', spiVersion: ENGINE_SPI_VERSION,
        platform: 'synthetic',
        async init() { events.push('init'); },
        async startAttempt() { events.push('start'); },
        async endAttempt() { events.push('end'); },
        async dispose() { events.push('dispose'); },
        fixtures: {
          transport: (ctx) => ctx.fixture('transport', {
            async request() { return 'accepted'; },
          }, { request: { kind: 'resource' } }),
        },
      });
      const cwd = mkdtempSync(path.join(tmpdir(), 'e2e-outcome-smoke-'));
      let host;
      try {
        host = await openHost({ cwd, env: {}, config: {
          targets: [{ name: 'synthetic', engine }], cache: 'off',
        } });
        const summaries = [];
        const outcomes = [
          { actual: 'failed', retryIndex: 0, testId: 'checkout/pay' },
          { actual: 'failed', expected: 'failed', retryIndex: 1, testId: 'checkout/pay' },
          { actual: 'skipped', retryIndex: 2, testId: 'checkout/pay' },
          { actual: 'passed', retryIndex: 3, testId: 'checkout/pay' },
        ];
        for (const outcome of outcomes) {
          const session = await host.openSession({ name: 'checkout/pay' });
          assert.equal(await session.fixtures.transport.request(), 'accepted');
          if (outcome.retryIndex === 3) sdkExpect.soft(1).toBe(2);
          const failures = await session.close({ outcome });
          assert.equal(await session.close({ outcome: { actual: 'passed' } }), failures);
          const final = session.outcome();
          assert.deepEqual(final.external, outcome);
          assert.equal(final.unexpected, outcome.retryIndex === 0 || outcome.retryIndex === 3);
          assert.equal(final.sdkStatus, outcome.retryIndex === 3 ? 'failed' : 'passed');
          assert.equal(failures.length, outcome.retryIndex === 3 ? 1 : 0);
          const trace = readFileSync(session.tracePath, 'utf8');
          assert.ok(trace.includes('## Session outcome'));
          assert.ok(trace.includes('External retry index: ' + outcome.retryIndex));
          assert.ok(trace.includes('transport.request'));
          summaries.push({ attemptId: session.attemptId, ...final });
        }
        assert.equal(new Set(summaries.map(s => s.attemptId)).size, 4);
        assert.deepEqual(await host.close(), []);
        assert.deepEqual(events, ['init', 'start', 'end', 'start', 'end', 'start', 'end', 'start', 'end', 'dispose']);
        console.log(JSON.stringify({ events, summaries }));
      } finally {
        if (host) await host.close();
        rmSync(cwd, { recursive: true, force: true });
      }
    `;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8', timeout: 30_000,
    });
    const smoke = JSON.parse(output) as { events: string[]; summaries: { status: string; unexpected: boolean; sdkStatus: string }[] };
    expect(smoke.events.filter((event) => event === 'end')).toHaveLength(4);
    expect(smoke.summaries.map(({ status, unexpected, sdkStatus }) => ({ status, unexpected, sdkStatus }))).toEqual([
      { status: 'failed', unexpected: true, sdkStatus: 'passed' },
      { status: 'failed', unexpected: false, sdkStatus: 'passed' },
      { status: 'skipped', unexpected: false, sdkStatus: 'passed' },
      { status: 'failed', unexpected: true, sdkStatus: 'failed' },
    ]);
  });
});
