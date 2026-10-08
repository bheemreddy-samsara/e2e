/**
 * `e2e/host` on the fake engine, from a config file as a host's project has
 * one: a session opens the target's engine with its fixtures, streams step
 * progress, lists its steps, needs a target when the config declares
 * several, and tears the engine down on close, once.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeEngine, FAKE_APP, type FakeEngineHandle } from '../helpers/fake-engine.ts';
import type { StepProgress } from '../../src/host/index.ts';

const hostModule = new URL('../../dist/host/index.js', import.meta.url).href;
const { openSession } = (await import(hostModule)) as typeof import('../../src/host/index.ts');

/** Where the config file below finds the fake engines this test made. */
const ENGINES = '__e2eHostTestEngines';

describe('openSession', { timeout: 60_000 }, () => {
  let dir: string;

  const writeConfig = (targets: Record<string, FakeEngineHandle>): void => {
    (globalThis as Record<string, unknown>)[ENGINES] = Object.fromEntries(Object.entries(targets).map(([name, fake]) => [name, fake.engine]));
    const entries = Object.keys(targets).map(
      (name) => `{ name: ${JSON.stringify(name)}, platform: 'kiosk', engine: globalThis.${ENGINES}[${JSON.stringify(name)}], app: ${JSON.stringify(FAKE_APP)} }`,
    );
    writeFileSync(path.join(dir, 'e2e.config.ts'), `export default { targets: [${entries.join(', ')}] };\n`);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-host-'));
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[ENGINES];
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens the target with its fixtures, streams steps, and closes once', async () => {
    const fake = createFakeEngine({ fixtures: true, artifacts: true });
    writeConfig({ kiosk: fake });
    const progress: StepProgress[] = [];
    const session = await openSession<{ gadget: unknown }>({ cwd: dir, env: {}, onStep: (step) => progress.push(step) });
    expect(session.target).toBe('kiosk');
    expect(session.fixtures.platform).toBe('kiosk');
    expect(session.fixtures.gadget).toBeDefined();
    expect(path.isAbsolute(session.artifactsDir)).toBe(true);

    await session.fixtures.app.screenshot('home');
    expect(progress.filter((step) => step.phase === 'start')).toHaveLength(1);
    expect(progress.filter((step) => step.phase === 'end')).toHaveLength(1);
    const shot = session.steps().find((step) => step.api === 'app.screenshot');
    expect(shot?.status).toBe('passed');
    expect(shot?.artifacts.length).toBe(1);

    expect(await session.close()).toEqual([]);
    expect(await session.close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, attemptsStarted: 1, attemptsEnded: 1, disposes: 1 });
  });

  it('needs a target when the config declares several, and opens the one named', async () => {
    const one = createFakeEngine();
    const two = createFakeEngine();
    writeConfig({ one, two });
    await expect(openSession({ cwd: dir, env: {} })).rejects.toMatchObject({ code: 'TARGET_REQUIRED' });
    await expect(openSession({ cwd: dir, env: {}, target: 'three' })).rejects.toMatchObject({ code: 'UNKNOWN_TARGET' });

    await using session = await openSession({ cwd: dir, env: {}, target: 'two' });
    expect(session.target).toBe('two');
    expect(one.stats().inits).toBe(0);
    expect(two.stats().inits).toBe(1);
  });
});
