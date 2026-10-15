/** Hosted report snapshots reuse the trace's document without handing out its ownership. */
import { mkdirSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports as syncModules } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { hostHarness, sdkExpect, secrets } from '../helpers/open-host.ts';
import { assertValidReport } from '../helpers/report-schema.ts';
import { createScriptedInstance, scriptedResult } from '../helpers/scripted-model.ts';

describe('openHost: report', { timeout: 60_000 }, () => {
  const { host, config, heldGate, dir } = hostHarness();

  it('returns independent closed snapshots, framework status, and results-root artifact references', async () => {
    const value = 'report-1';
    const handle = secrets.get('reportText');
    const fake = createFakeEngine({ fixtures: true, artifacts: true, secrets: [handle] });
    const engine = { ...fake.engine, name: 'fixture-engine' };
    const opened = await host(engine, { config: config(engine, { projectId: 'project-' + value, secrets: { reportText: () => value } }) });
    const session = await opened.openSession({ name: 'snapshot ' + value });
    expect(session.report()).toBeUndefined();
    await session.fixtures.app.screenshot();
    await session.fixtures.gadget.dropFile();
    sdkExpect.soft(1, value + 'x'.repeat(9000)).toBe(2);
    expect(await fake.attempts[0]!.resolveSecret(handle)).toBe(value);
    expect(await session.close()).toHaveLength(1);
    const snapshot = session.report()!;
    assertValidReport(snapshot);
    expect(snapshot.schemaVersion).toBe('report-1');
    expect(snapshot.run.status).toBe('failed');
    expect(snapshot.run.project.id).toBe('project-<secret:reportText>');
    const attempt = snapshot.run.results[0]!.attempts[0]!;
    expect(attempt.error!.message).toContain('<secret:reportText>');
    expect(Buffer.byteLength(attempt.error!.message)).toBeLessThanOrEqual(8192);
    for (const artifact of attempt.artifacts) {
      expect(readFileSync(path.join(dir(), '.e2e', 'results', artifact.path!)).length).toBe(artifact.size);
      expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const original = JSON.stringify(snapshot);
    const steps = JSON.stringify(session.steps());
    snapshot.run.usage.modelTokens = 999;
    snapshot.run.targets[0]!.engine.name = 'caller mutation';
    attempt.artifacts[0]!.size = 999;
    expect(JSON.stringify(session.report())).toBe(original);
    expect(JSON.stringify(session.steps())).toBe(steps);
    engine.name = 'later metadata';
    const next = await opened.openSession({ name: 'next attempt' });
    await next.close();
    await opened.close();
    expect(JSON.stringify(session.report())).toBe(original);
    expect(await session.close()).toHaveLength(1);
    expect(readFileSync(session.tracePath, 'utf8')).toContain('secret:reportText');
  });

  it('stays unavailable while the trace write is pending', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'pending write' });
    const entered = heldGate();
    const proceed = heldGate();
    const rename = fs.rename;
    const spy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === session.tracePath) {
        entered.resolve();
        await proceed.promise;
      }
      return rename(from, to);
    });
    syncModules();
    const closing = session.close();
    try {
      await entered.promise;
      expect(session.report()).toBeUndefined();
      proceed.resolve();
      expect(await closing).toEqual([]);
      expect(session.report()).toBeDefined();
    } finally {
      proceed.resolve();
      try {
        await closing;
      } finally {
        spy.mockRestore();
        syncModules();
      }
    }
  });

  it('does not publish a report when the trace write fails', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'failed write' });
    mkdirSync(session.tracePath);
    const failures = await session.close();
    expect(failures).toHaveLength(1);
    expect(session.report()).toBeUndefined();
    expect(await session.close()).toEqual(failures);
  });

  it.each(['call', 'outcome', 'notes'] as const)('preserves actual %s cuts through known redaction for late provider values', async (role) => {
    const value = 'Q7zK4vN9pR2s';
    const known = 'before-cut-static-9Q';
    const prefix = value.slice(0, 6);
    const token = secrets.get('cutToken');
    const callHead = 'complete_step(' + JSON.stringify({ status: 'passed', summary: '' }).slice(0, -2);
    const head = role === 'call' ? callHead : role === 'outcome' ? 'assistant: ' : '[loop] loop guard warned before turn 4: the same "';
    const cap = role === 'call' ? 200 : role === 'outcome' ? 600 : 1000;
    const payload = known + 'x'.repeat(cap - head.length - known.length - prefix.length) + value;
    let resolutions = 0;
    let calls = 0;
    const fake = createFakeEngine({ secrets: [token] });
    const model = createScriptedInstance('fake', 'scripted', async () => {
      calls += 1;
      return scriptedResult(role === 'notes' && calls <= 3 ? [
        { type: 'tool-call', toolCallId: 'unknown-' + calls, toolName: payload, input: '{}' },
      ] : [
        ...(role === 'outcome' ? [{ type: 'text', text: payload }] : []),
        { type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: role === 'call' ? payload : 'safe summary' }) },
      ], 'tool-calls');
    });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      agents: { default: { model } },
      secrets: { cutToken: () => { resolutions += 1; return value; }, clipWord: 'truncated', before: known },
    }) });
    const session = await opened.openSession({ name: 'producer boundaries' });
    const result = await session.fixtures.agent.act('Conclude the step');
    expect(result).toMatchObject({ modelCalls: role === 'notes' ? 4 : 1, actions: 0 });
    expect(resolutions).toBe(0);
    const before = JSON.stringify(session.steps());
    const turn = session.steps()[0]!.turns![role === 'notes' ? 2 : 0]!;
    const raw = role === 'call' ? turn.calls[0]! : turn.outcome;
    expect(raw).toContain(prefix + '…[<secret:clipWord>]');
    expect(raw).toContain('<secret:before>');
    expect(await fake.attempts[0]!.resolveSecret(token)).toBe(value);
    expect(resolutions).toBe(1);
    expect(await session.close()).toEqual([]);
    const report = session.report()!;
    assertValidReport(report);
    const reported = report.run.results[0]!.attempts[0]!.steps[0]!;
    expect(JSON.stringify(report)).not.toContain(value);
    expect(JSON.stringify(report)).not.toContain(prefix);
    expect(JSON.stringify(session.steps())).toBe(before);
    expect(reported.events).toEqual(session.steps()[0]!.events);
    expect(reported.metrics).toEqual(session.steps()[0]!.metrics);
    expect(report.run.usage.modelTokens).toBe(calls * 120);
    expect(JSON.stringify(reported.turns)).toContain('<secret:cutToken>');
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(prefix);
  });

  it('uses producer provenance even when a public alias spans the SDK suffix and a loop note', async () => {
    const value = 'B9nQ4pL7xV2s';
    const marker = '…[truncated]';
    const alias = 'boundary>\n[loop] loop guard warned before turn 4: the same "missing';
    const names = ['lateNote', 'boundary', alias];
    const values = [value, marker, 'second-provider-value-123'];
    const handles = names.map((name) => secrets.get(name));
    const fake = createFakeEngine({ secrets: handles });
    const payload = 'x'.repeat(600 - 'assistant: '.length - 6) + value;
    let calls = 0;
    const model = createScriptedInstance('fake', 'scripted', async () => {
      calls += 1;
      return scriptedResult(calls <= 3 ? [
        { type: 'text', text: payload },
        { type: 'tool-call', toolCallId: 'unknown-' + calls, toolName: 'missing>', input: '{}' },
      ] : [{ type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'safe summary' }) }], 'tool-calls');
    });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      agents: { default: { model } }, secrets: Object.fromEntries(names.map((name, i) => [name, () => values[i]!])),
    }) });
    const session = await opened.openSession({ name: 'opaque note aliases' });
    expect(await session.fixtures.agent.act('Conclude the step')).toMatchObject({ modelCalls: 4, actions: 0 });
    const before = JSON.stringify(session.steps());
    for (const handle of handles) await fake.attempts[0]!.resolveSecret(handle);
    expect(await session.close()).toEqual([]);
    const report = session.report()!;
    assertValidReport(report);
    expect(JSON.stringify(report)).not.toContain(value.slice(0, 6));
    expect(report.run.usage.modelTokens).toBe(480);
    expect(JSON.stringify(session.steps())).toBe(before);
  });

  it('keeps whole-value masking when a known value consumes an SDK cut', async () => {
    const value = 'K8tM3wP6sZ2r';
    const spanning = value.slice(0, 6) + '…[truncated]';
    const handles = [secrets.get('spanning'), secrets.get('lateWhole')];
    const fake = createFakeEngine({ secrets: handles });
    const payload = 'x'.repeat(600 - 'assistant: '.length - 6) + value;
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([
      { type: 'text', text: payload },
      { type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: 'safe summary' }) },
    ], 'tool-calls'));
    const opened = await host(fake.engine, { config: config(fake.engine, {
      agents: { default: { model } }, secrets: { spanning: () => spanning, lateWhole: () => value },
    }) });
    const session = await opened.openSession({ name: 'whole boundary match' });
    await session.fixtures.agent.act('Conclude the step');
    const before = session.steps()[0]!.turns![0]!.outcome;
    for (const handle of handles) await fake.attempts[0]!.resolveSecret(handle);
    expect(await session.close()).toEqual([]);
    const report = session.report()!;
    assertValidReport(report);
    expect(report.run.results[0]!.attempts[0]!.steps[0]!.turns![0]!.outcome).toBe(before.replace(spanning, '<secret:spanning>'));
  });

  it('keeps an opaque canonical alias intact when a whole value was never SDK-clipped', async () => {
    const value = 'W8pJ3tR6mX2q';
    const name = 'base>W8pJ3t…[truncated]alias';
    const token = secrets.get(name);
    const peer = secrets.get('base');
    const fake = createFakeEngine({ secrets: [token, peer] });
    const model = createScriptedInstance('fake', 'scripted', async () => scriptedResult([
      { type: 'tool-call', toolCallId: 'done', toolName: 'complete_step', input: JSON.stringify({ status: 'passed', summary: value }) },
    ], 'tool-calls'));
    const opened = await host(fake.engine, { config: config(fake.engine, {
      agents: { default: { model } }, secrets: { [name]: () => value, base: () => 'peer-provider-value-123' },
    }) });
    const session = await opened.openSession({ name: 'whole-value alias' });
    await session.fixtures.agent.act('Conclude the step');
    const before = session.steps()[0]!.turns![0]!.calls[0]!;
    expect(before).toContain(value);
    await fake.attempts[0]!.resolveSecret(token);
    await fake.attempts[0]!.resolveSecret(peer);
    expect(await session.close()).toEqual([]);
    const call = session.report()!.run.results[0]!.attempts[0]!.steps[0]!.turns![0]!.calls[0]!;
    expect(call).toBe(before.replace(value, '<secret:' + name + '>'));
  });
  it('preserves the factual environment enum when a secret has the same value', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, {
      targets: [{ name: 'kiosk', platform: 'kiosk', engine: fake.engine, app: { ...FAKE_APP, environment: 'production' } }],
      secrets: { envToken: 'production' },
    }) });
    const session = await opened.openSession({ name: 'environment enum check' });
    expect(await session.close()).toEqual([]);
    const report = session.report()!;
    expect(report.run.targets[0]!.environment).toBe('production');
    expect(report.run.status).toBe('passed');
    assertValidReport(report);
  });

  it('masks a late-known prefix at the SDK surrogate-safe app log cut', async () => {
    const value = 'J8tR4v😀N2s';
    const prefix = value.slice(0, 6);
    const token = secrets.get('unicodeCut');
    let resolutions = 0;
    const fake = createFakeEngine({ secrets: [token] });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      secrets: { unicodeCut: () => { resolutions += 1; return value; } },
    }) });
    const control = await opened.openSession({ name: 'unresolved log control' });
    fake.attempts[0]!.appLog({ source: 'console', level: 'info', text: 'x'.repeat(292) + value });
    expect(await control.close()).toEqual([]);
    const raw = control.report()!.run.results[0]!.attempts[0]!.appLog![0]!.text;
    expect(raw).toHaveLength(299);
    expect(raw).toBe('x'.repeat(292) + prefix + '…');
    const session = await opened.openSession({ name: 'unicode log clipping' });
    fake.attempts[1]!.appLog({ source: 'console', level: 'info', text: 'x'.repeat(292) + value });
    expect(resolutions).toBe(0);
    const before = JSON.stringify(session.steps());
    expect(await fake.attempts[1]!.resolveSecret(token)).toBe(value);
    expect(resolutions).toBe(1);
    expect(await session.close()).toEqual([]);
    const report = session.report()!;
    assertValidReport(report);
    expect(JSON.stringify(report)).not.toContain(value);
    expect(JSON.stringify(report)).not.toContain(prefix);
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(prefix);
    expect(JSON.stringify(session.steps())).toBe(before);
    expect(report.run.status).toBe('passed');
    expect(report.run.usage.modelTokens).toBe(0);
  });
});
