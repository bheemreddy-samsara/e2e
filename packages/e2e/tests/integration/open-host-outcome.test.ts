/** External-runner facts never replace SDK failures or control retry execution. */
import nativeFs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import fs from 'node:fs/promises';
import { Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { E2ESession, CloseSessionOptions, ExternalOutcome } from '../../src/runner.ts';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness, sdkExpect, secrets, type GadgetFixtures } from '../helpers/open-host.ts';
import { contentsUnder } from '../helpers/run-project.ts';

describe('openHost: external outcome', { timeout: 60_000 }, () => {
  const { host, config, heldGate } = hostHarness();

  it.each([
    [{ actual: 'failed' }, 'failed', true],
    [{ actual: 'timed-out' }, 'timed-out', true],
    [{ actual: 'interrupted' }, 'interrupted', true],
    [{ actual: 'skipped' }, 'skipped', false],
    [{ actual: 'failed', expected: 'failed' }, 'failed', false],
    [{ actual: 'timed-out', expected: 'timed-out' }, 'timed-out', false],
    [{ actual: 'passed', expected: 'failed' }, 'failed', true],
    [{ actual: 'passed' }, 'passed', false],
  ] satisfies [ExternalOutcome, string, boolean][])('reports %j as %s; unexpected=%s drives video retention', async (external, status, unexpected) => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'external assertion' });
    expect(session.outcome()).toBeUndefined();
    await session.fixtures.app.open();
    expect(await session.close({ outcome: external })).toEqual([]);
    expect(session.outcome()).toEqual({ status, unexpected, sdkStatus: 'passed', external });
    expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(unexpected);
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('## Session outcome');
    expect(trace).toContain('SDK: **passed**');
    expect(trace).toContain('External: **');
    expect(trace).toContain(unexpected ? ', unexpected.' : ', not unexpected.');
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('keeps independent retries in separate sessions with stable external identity', async () => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const first = await opened.openSession({ name: 'retry test' });
    await first.close({ outcome: { actual: 'failed', retryIndex: 0, testId: 'suite/checkout' } });
    const second = await opened.openSession({ name: 'retry test' });
    await second.close({ outcome: { actual: 'passed', retryIndex: 1, testId: 'suite/checkout' } });
    expect(first.attemptId).not.toBe(second.attemptId);
    expect(first.artifactsDir).not.toBe(second.artifactsDir);
    expect(first.outcome()?.external).toMatchObject({ testId: 'suite/checkout', retryIndex: 0 });
    expect(second.outcome()?.external).toMatchObject({ testId: 'suite/checkout', retryIndex: 1 });
    expect(readFileSync(second.tracePath, 'utf8')).toContain('External retry index: 1');
    expect(fake.stats().attemptsStarted).toBe(2);
  });

  it.each(['soft', 'abandoned', 'timeout', 'cleanup'] as const)('external pass never erases SDK %s failure', async (kind) => {
    const fake = createFakeEngine({ fixtures: true, video: true,
      ...(kind === 'cleanup' ? { onEndAttempt: () => { throw new Error('cleanup broke'); } } : {}),
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: kind, timeout: kind === 'timeout' ? 20 : 5_000 });
    if (kind === 'soft') sdkExpect.soft(1).toBe(2);
    if (kind === 'abandoned') session.fixtures.gadget.hang();
    if (kind === 'timeout') await expect(session.fixtures.gadget.hang()).rejects.toMatchObject({ code: 'TEST_TIMEOUT' });
    const failures = await session.close({ outcome: { actual: 'passed' } });
    expect(failures.length).toBeGreaterThan(0);
    expect(session.outcome()).toMatchObject({ sdkStatus: kind === 'timeout' ? 'timed-out' : 'failed', unexpected: true, external: { actual: 'passed' } });
    expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(true);
    expect(readFileSync(session.tracePath, 'utf8')).toContain('External: **passed**');
  });

  it('expected external failure cannot absorb a soft assertion', async () => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'expected failure with SDK failure' });
    sdkExpect.soft(1).toBe(2);
    expect(await session.close({ outcome: { actual: 'failed', expected: 'failed' } })).toContainEqual(expect.objectContaining({ code: 'ASSERTION_FAILED' }));
    expect(session.outcome()?.unexpected).toBe(true);
    expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(true);
  });

  it('registers valid video segments only once when another segment is rejected', async () => {
    const fake = createFakeEngine({ video: true, videoLinks: ['file:///tmp/bad.mp4'] });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) {
        uploads.push(artifact.path);
        return { ref: 'stored:' + artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'partial video registration' });
    const failures = await session.close({ outcome: { actual: 'failed' } });
    expect(failures).toContainEqual(expect.objectContaining({ code: 'ENGINE_FAILURE', phase: 'cleanup' }));
    expect(uploads.filter((file) => file.endsWith('fake.webm'))).toHaveLength(1);
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace.split('\n').filter((line) => line.startsWith('- [video]('))).toHaveLength(1);
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('first close wins while cleanup is pending; caller mutations and later closes cannot change it', async () => {
    const cleanup = heldGate();
    const fake = createFakeEngine({ onEndAttempt: () => cleanup.promise });
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'concurrent close' });
    const external: { actual: 'failed' | 'passed'; testId: string } = { actual: 'failed', testId: 'original' };
    const closing = session.close({ outcome: external });
    external.actual = 'passed';
    external.testId = 'mutated';
    const repeated = session.close({ outcome: { actual: 'passed' } });
    expect(repeated).toBe(closing);
    expect(session.outcome()).toBeUndefined();
    cleanup.resolve();
    const failures = await closing;
    expect(await session.close({ outcome: { actual: 'skipped' } })).toBe(failures);
    expect(session.outcome()?.external).toEqual({ actual: 'failed', testId: 'original' });
    expect(Object.isFrozen(session.outcome())).toBe(true);
    expect(Object.isFrozen(session.outcome()?.external)).toBe(true);
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it.each([
    null, { outcome: {} }, { outcome: { actual: 'unknown' } },
    { outcome: { actual: 'failed', expected: 'unknown' } },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((retryIndex) => ({ outcome: { actual: 'failed', retryIndex } })),
    ...['', 'x'.repeat(257), 7].map((testId) => ({ outcome: { actual: 'failed', testId } })),
    { outcome: { actual: 'failed', error: new Error('private raw error') } },
    { outcome: { actual: 'failed', cause: 'private cause' } },
    { outcome: Object.defineProperty({}, 'actual', { get() { throw new Error('private getter'); } }) },
    { outcome: { actual: 'failed', [Symbol('private')]: true } },
  ])('invalid metadata %j still closes once and never retains raw payloads', async (options) => {
    const fake = createFakeEngine();
    const opened = await host(fake.engine);
    const session = await opened.openSession({ name: 'invalid close' });
    const failures = await session.close(options as CloseSessionOptions);
    expect(failures).toEqual([expect.objectContaining({ code: 'INVALID_CONFIG' })]);
    expect(await session.close()).toBe(failures);
    expect(fake.stats().attemptsEnded).toBe(1);
    expect(session.outcome()).toMatchObject({ status: 'failed', unexpected: true, sdkStatus: 'failed' });
    expect(session.outcome()?.external).toBeUndefined();
    expect(readFileSync(session.tracePath, 'utf8')).not.toMatch(/private (raw error|cause|getter)/);
    expect(await (await opened.openSession({ name: 'next test' })).close()).toEqual([]);
  });

  it.each(['secret', 'credential'] as const)('omits identity without resolving an unused %s provider or retiring a clean worker', async (kind) => {
    const provider = vi.fn(() => 'unused-provider-token-123');
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, kind === 'secret'
      ? { secrets: { unused: provider } }
      : { credentials: { unused: { username: 'account', password: provider } } }) });
    const session = await opened.openSession({ name: 'unused provider' });
    expect(await session.close({ outcome: { actual: 'failed', expected: 'failed', retryIndex: 1, testId: 'stable-but-unverifiable' } })).toEqual([]);
    expect(session.outcome()).toEqual({ status: 'failed', sdkStatus: 'passed', unexpected: false,
      external: { actual: 'failed', expected: 'failed', retryIndex: 1 } });
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain('External test:');
    expect(contentsUnder(session.artifactsDir).some(([, bytes]) => bytes.includes('stable-but-unverifiable'))).toBe(false);
    expect(await (await opened.openSession({ name: 'same worker' })).close()).toEqual([]);
    expect(fake.stats()).toMatchObject({ inits: 1, disposes: 0, attemptsStarted: 2 });
    await opened.close();
    expect(provider).not.toHaveBeenCalled();
  });

  it('does not treat a resolved provider ledger as complete or resolve it again for identity', async () => {
    const handle = secrets.get('rotatingToken');
    const laterValue = 'future-provider-value-456';
    const provider = vi.fn().mockReturnValueOnce('initial-provider-value-123').mockReturnValue(laterValue);
    let resolveSecret!: () => Promise<string>;
    const fake = createFakeEngine({ secrets: [handle],
      onStartAttempt: async (context) => {
        resolveSecret = () => context.resolveSecret(handle);
        await resolveSecret();
      },
      onDispose: async () => { await resolveSecret(); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { rotatingToken: provider } }) });
    const session = await opened.openSession({ name: 'fresh provider values' });
    expect(await session.close({ outcome: { actual: 'passed', testId: laterValue } })).toEqual([]);
    const final = session.outcome();
    expect(final?.external).toEqual({ actual: 'passed' });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(fake.stats().disposes).toBe(0);
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).not.toContain(laterValue);
    expect(trace).not.toContain('External test:');
    await opened.close();
    expect(provider).toHaveBeenCalledTimes(2);
    expect(session.outcome()).toBe(final);
    expect(readFileSync(session.tracePath, 'utf8')).toBe(trace);
  });

  it.each(['literal', 'environment'] as const)('retains bounded identity redacted with %s secrets and no providers', async (kind) => {
    const secret = `static-identity-token-${kind}`;
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { staticToken: kind === 'literal' ? secret : 'configured-default-123' } }),
      ...(kind === 'environment' ? { env: { E2E_SECRET_STATICTOKEN: secret } } : {}),
    });
    const session = await opened.openSession({ name: 'static identity' });
    expect(await session.close({ outcome: { actual: 'passed', testId: `suite/${secret}/checkout` } })).toEqual([]);
    expect(session.outcome()?.external?.testId).toBe('suite/<secret:staticToken>/checkout');
    expect(readFileSync(session.tracePath, 'utf8')).toContain('suite/<secret:staticToken>/checkout');
    for (const [file, bytes] of contentsUnder(session.artifactsDir)) expect(bytes, file).not.toContain(secret);
  });

  it('withholds external identity when provider secrets first resolve during cleanup', async () => {
    const secret = 'provider-cleanup-token-123';
    const handle = secrets.get('providerToken');
    let resolveSecret!: () => Promise<string>;
    const fake = createFakeEngine({
      secrets: [handle],
      onStartAttempt: (context) => { resolveSecret = () => context.resolveSecret(handle); },
      onEndAttempt: async () => { await resolveSecret(); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { providerToken: () => secret } }) });
    const session = await opened.openSession({ name: 'cleanup secret' });
    await session.close({ outcome: { actual: 'failed', testId: secret } });
    expect(session.outcome()?.external).toEqual({ actual: 'failed' });
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain('External test:');
    expect(JSON.stringify(session.outcome())).not.toContain(secret);
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(secret);
  });

  it('withholds external identity before retirement disposal and trace writing', async () => {
    const secret = 'provider-disposal-token-123';
    const handle = secrets.get('disposalToken');
    let resolveSecret!: () => Promise<string>;
    const fake = createFakeEngine({
      secrets: [handle],
      onStartAttempt: (context) => { resolveSecret = () => context.resolveSecret(handle); },
      onEndAttempt: () => { throw new Error('retire worker'); },
      onDispose: async () => { await resolveSecret(); },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { disposalToken: () => secret } }) });
    const session = await opened.openSession({ name: 'disposal secret' });
    await session.close({ outcome: { actual: 'failed', testId: secret } });
    expect(session.outcome()?.external).toEqual({ actual: 'failed' });
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain('External test:');
    expect(readFileSync(session.tracePath, 'utf8')).not.toContain(secret);
    expect(fake.stats().disposes).toBe(1);
  });

  it.each([false, true])('never publishes disposal-time secrets after late video deletion failure; blocked publication=%s', async (blocked) => {
    const secret = `late-video-disposal-token-${blocked}`;
    const handle = secrets.get('lateVideoToken');
    let resolveSecret!: () => Promise<string>;
    let artifactsDir = '';
    let atDisposal: [string, string][] = [];
    const fake = createFakeEngine({
      video: true, secrets: [handle],
      onStartAttempt: (context) => { resolveSecret = () => context.resolveSecret(handle); },
      onEndAttempt: () => { chmodSync(path.join(artifactsDir, 'video'), 0o555); },
      onDispose: async () => {
        // Capture every intermediate file, before the provider value joins the ledger.
        atDisposal = contentsUnder(artifactsDir);
        await resolveSecret();
        if (blocked) chmodSync(artifactsDir, 0o555);
      },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', secrets: { lateVideoToken: () => secret },
    }) });
    const session = await opened.openSession({ name: 'late video secret' });
    artifactsDir = session.artifactsDir;
    try {
      const failures = await session.close({ outcome: { actual: 'passed', testId: secret } });
      expect(fake.stats().disposes).toBe(1);
      expect(atDisposal.length).toBeGreaterThan(0);
      expect(atDisposal.some(([file]) => file === session.tracePath)).toBe(false);
      for (const [file, bytes] of [...atDisposal, ...contentsUnder(artifactsDir)]) {
        expect(bytes, file).not.toContain(secret);
      }
      expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(session.outcome()?.external).toEqual({ actual: 'passed' });
      expect(existsSync(path.join(artifactsDir, 'video/fake.webm'))).toBe(true);
      if (!blocked) expect(readFileSync(session.tracePath, 'utf8')).not.toContain('External test:');
      else expect(failures.length).toBeGreaterThan(1);
    } finally {
      chmodSync(artifactsDir, 0o755);
      chmodSync(path.join(artifactsDir, 'video'), 0o755);
    }
  });

  it.each([
    { actual: 'passed' }, { actual: 'failed', expected: 'failed' },
  ] satisfies ExternalOutcome[])('keeps failure-only video when trace writing fails after %j', async (outcome) => {
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'trace write failure' });
    mkdirSync(session.tracePath);
    const failures = await session.close({ outcome });
    expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
    expect(session.outcome()).toMatchObject({ status: 'failed', sdkStatus: 'failed', unexpected: true, external: outcome });
    expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(true);
    expect(fake.stats().attemptsEnded).toBe(1);
  });

  it('recovers discarded video when final publication fails after successful preparation', async () => {
    const fake = createFakeEngine({ video: true });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) {
        uploads.push(artifact.path);
        return { ref: 'stored:' + artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'late trace publication failure' });
    const videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    const remove = fs.rm;
    let deleted = false;
    const deletion = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      await remove(file, options);
      if (String(file).includes(path.sep + 'claim-') && String(file).endsWith(path.sep + 'segment')) {
        deleted = !existsSync(videoPath);
        chmodSync(session.artifactsDir, 0o555);
      }
    });
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'passed' } });
      expect(deleted).toBe(true);
      expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(readFileSync(videoPath).length).toBeGreaterThan(0);
      expect(uploads.filter((file) => file.endsWith('fake.webm'))).toHaveLength(1);
      expect(existsSync(session.tracePath)).toBe(false);
      // Trace persistence failure does not invalidate clean engine isolation.
      expect(fake.stats().disposes).toBe(0);
    } finally {
      deletion.mockRestore();
      syncBuiltinESMExports();
      chmodSync(session.artifactsDir, 0o755);
    }
    expect(await (await opened.openSession({ name: 'clean worker reused' })).close()).toEqual([]);
  });

  it('restores the original video inode when publication hits ENOSPC and byte-copy recovery would truncate it', async () => {
    const fake = createFakeEngine({ video: true });
    const uploaded: { bytes: Buffer; links: number }[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) {
        uploaded.push({ bytes: Buffer.from(artifact.bytes), links: statSync(path.join(session.artifactsDir, 'video/fake.webm')).nlink });
        return { ref: 'stored:' + artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'disk full at publication' });
    const videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    let original: Buffer | undefined;
    let inode: number | undefined;
    const open = fs.open;
    const reservation = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(session.tracePath + '.')) {
        vi.spyOn(file, 'writeFile').mockImplementation(async () => {
          expect(existsSync(videoPath)).toBe(false);
          throw Object.assign(new Error('publication disk full'), { code: 'ENOSPC' });
        });
      }
      return file;
    });
    const remove = fs.rm;
    const deletion = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file).includes(path.sep + 'claim-') && existsSync(file)) {
        original = readFileSync(file);
        inode = statSync(file).ino;
      }
      await remove(file, options);
    });
    const copy = vi.spyOn(nativeFs, 'createWriteStream').mockImplementation(() => new Writable({
      write(chunk, _encoding, callback) {
        writeFileSync(videoPath, chunk.subarray(0, 1));
        callback(Object.assign(new Error('recovery disk full'), { code: 'ENOSPC' }));
      },
    }) as ReturnType<typeof nativeFs.createWriteStream>);
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'failed', expected: 'failed' } });
      expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(original?.length).toBeGreaterThan(1);
      expect(readFileSync(videoPath)).toEqual(original);
      expect(statSync(videoPath).ino).toBe(inode);
      expect(statSync(videoPath).nlink).toBe(1);
      expect(uploaded).toEqual([{ bytes: original, links: 1 }]);
      expect(copy).not.toHaveBeenCalled();
      expect(existsSync(session.tracePath)).toBe(false);
      expect(fake.stats().disposes).toBe(0);
      expect(await session.close()).toBe(failures);
    } finally {
      reservation.mockRestore();
      deletion.mockRestore();
      copy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await (await opened.openSession({ name: 'worker remains reusable' })).close()).toEqual([]);
  });

  it.each([false, true])('withholds disposal-time identity at the first partial trace write; failed temp unlink=%s', async (blockedUnlink) => {
    const secret = `partial-trace-disposal-token-${blockedUnlink}`;
    const handle = secrets.get('partialTraceToken');
    let resolveSecret!: () => Promise<string>;
    let providerCalls = 0;
    let atDisposal: [string, string][] = [];
    const fake = createFakeEngine({
      video: true, secrets: [handle],
      onStartAttempt: (context) => { resolveSecret = () => context.resolveSecret(handle); },
      onDispose: async () => {
        atDisposal = contentsUnder(session.artifactsDir);
        await resolveSecret();
      },
    });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', secrets: { partialTraceToken: () => { providerCalls++; return secret; } },
    }) });
    const session = await opened.openSession({ name: 'partial trace before disposal' });
    const videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    let temporary = '';
    let firstWrite = '';
    let firstBytes = '';
    let callsAtWrite = -1;
    let disposalsAtWrite = -1;
    let deletedAtWrite = false;
    const open = fs.open;
    const reservation = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(session.tracePath + '.')) {
        temporary = String(args[0]);
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementation(async (content) => {
          firstWrite = String(content);
          callsAtWrite = providerCalls;
          disposalsAtWrite = fake.stats().disposes;
          deletedAtWrite = !existsSync(videoPath);
          await write(firstWrite.slice(0, -1), 'utf8');
          firstBytes = readFileSync(temporary, 'utf8');
          throw Object.assign(new Error('partial trace disk full'), { code: 'ENOSPC' });
        });
      }
      return file;
    });
    const link = fs.link;
    const restoration = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (destination === videoPath) throw Object.assign(new Error('restore disk full'), { code: 'ENOSPC' });
      await link(source, destination);
    });
    const unlink = fs.unlink;
    const tempCleanup = vi.spyOn(fs, 'unlink').mockImplementation(async (file) => {
      if (blockedUnlink && file === temporary) throw new Error('temporary cleanup blocked');
      await unlink(file);
    });
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'passed', expected: 'passed', retryIndex: 2, testId: secret } });
      expect(deletedAtWrite).toBe(true);
      expect(callsAtWrite).toBe(0);
      expect(disposalsAtWrite).toBe(0);
      expect(providerCalls).toBe(1);
      expect(fake.stats().disposes).toBe(1);
      expect(failures.length).toBeGreaterThan(1);
      expect(firstBytes.length).toBeGreaterThan(0);
      expect(firstBytes.length).toBeLessThan(firstWrite.length);
      expect(firstWrite).not.toContain(secret);
      expect(firstBytes).not.toContain(secret);
      for (const [file, bytes] of [...atDisposal, ...contentsUnder(session.artifactsDir)]) expect(bytes, file).not.toContain(secret);
      expect(existsSync(temporary)).toBe(blockedUnlink);
      if (blockedUnlink) expect(readFileSync(temporary, 'utf8')).toBe(firstBytes);
      expect(JSON.stringify(failures)).not.toContain(secret);
      expect(session.outcome()).toEqual({ status: 'failed', sdkStatus: 'failed', unexpected: true,
        external: { actual: 'passed', expected: 'passed', retryIndex: 2 } });
      expect(firstWrite).not.toContain('External test:');
      expect(firstWrite).toContain('External retry index: 2');
      expect(await session.close()).toBe(failures);
    } finally {
      reservation.mockRestore();
      restoration.mockRestore();
      tempCleanup.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('keeps the complete private inode when both publication and atomic restoration fail', async () => {
    const fake = createFakeEngine({ video: true });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) { uploads.push(artifact.path); return { ref: artifact.path }; } } },
    }) });
    const session = await opened.openSession({ name: 'failed atomic restore' });
    const videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    let original: Buffer | undefined;
    let inode: number | undefined;
    const remove = fs.rm;
    const deletion = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file).includes(path.sep + 'claim-') && existsSync(file)) {
        original = readFileSync(file);
        inode = statSync(file).ino;
      }
      await remove(file, options);
    });
    const open = fs.open;
    const reservation = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(session.tracePath + '.')) {
        vi.spyOn(file, 'writeFile').mockRejectedValue(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      return file;
    });
    const link = fs.link;
    const restoration = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (destination === videoPath) throw Object.assign(new Error('restore disk full'), { code: 'ENOSPC' });
      await link(source, destination);
    });
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'passed' } });
      expect(failures.length).toBeGreaterThan(1);
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(existsSync(videoPath)).toBe(false);
      const directories = readdirSync(session.artifactsDir).filter((name) => name.startsWith('.video-recovery-'));
      expect(directories).toHaveLength(1);
      const recoveryDir = path.join(session.artifactsDir, directories[0]!);
      const recovery = path.join(recoveryDir, 'segment');
      expect(original?.length).toBeGreaterThan(1);
      expect(readFileSync(recovery)).toEqual(original);
      expect(statSync(recovery).ino).toBe(inode);
      expect(statSync(recovery).nlink).toBe(1);
      expect(statSync(recoveryDir).mode & 0o777).toBe(0o700);
      expect(uploads).toEqual([]);
      expect(existsSync(session.tracePath)).toBe(false);
      expect(fake.stats().disposes).toBe(1);
      expect(await session.close()).toBe(failures);
      expect(readFileSync(recovery)).toEqual(original);
    } finally {
      deletion.mockRestore();
      reservation.mockRestore();
      restoration.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('does not retire a worker for private recovery cleanup failure after trace publication', async () => {
    const fake = createFakeEngine({ video: true });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) { uploads.push(artifact.path); return { ref: artifact.path }; } } },
    }) });
    const session = await opened.openSession({ name: 'private cleanup maintenance' });
    const remove = fs.rm;
    const cleanup = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (String(file).includes('.video-recovery-') && !String(file).includes(path.sep + 'claim-')) {
        expect(existsSync(session.tracePath)).toBe(true);
        throw new Error('private cleanup blocked');
      }
      await remove(file, options);
    });
    syncBuiltinESMExports();
    try {
      expect(await session.close({ outcome: { actual: 'passed', testId: 'checkout' } })).toEqual([]);
      expect(session.outcome()).toMatchObject({ sdkStatus: 'passed', unexpected: false });
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace).toContain('checkout');
      expect(trace).not.toContain('.video-recovery-');
      expect(trace).not.toContain('- [video](');
      expect(uploads).toEqual([]);
      expect(existsSync(path.join(session.artifactsDir, 'video/fake.webm'))).toBe(false);
      expect(readdirSync(session.artifactsDir).filter((name) => name.startsWith('.video-recovery-'))).toHaveLength(1);
      expect(fake.stats().disposes).toBe(0);
    } finally {
      cleanup.mockRestore();
      syncBuiltinESMExports();
    }
    expect(await (await opened.openSession({ name: 'worker stays reusable' })).close()).toEqual([]);
  });

  it.each([
    { actual: 'passed' }, { actual: 'failed', expected: 'failed' },
  ] satisfies ExternalOutcome[])('registers surviving video once when deletion fails after %j', async (outcome) => {
    let videoDir = '';
    const fake = createFakeEngine({ video: true, onEndAttempt: () => { chmodSync(videoDir, 0o555); } });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure',
      artifacts: { store: { async put(artifact) {
        uploads.push(artifact.path);
        return { ref: 'stored:' + artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'video deletion failure' });
    videoDir = path.join(session.artifactsDir, 'video');
    try {
      const failures = await session.close({ outcome });
      expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
      expect(session.outcome()).toMatchObject({ status: 'failed', sdkStatus: 'failed', unexpected: true });
      expect(existsSync(path.join(videoDir, 'fake.webm'))).toBe(true);
      expect(uploads.filter((file) => file.endsWith('fake.webm'))).toHaveLength(1);
      const trace = readFileSync(session.tracePath, 'utf8');
      expect(trace.split('\n').filter((line) => line.startsWith('- [video]('))).toHaveLength(1);
      expect(trace).toContain('unexpected');
    } finally {
      chmodSync(videoDir, 0o755);
    }
  });

  it.each(['staging', 'restore', 'permanent staging', 'permanent restore'] as const)('fences pending %s before rendered bytes and closes within the cleanup budget', async (kind) => {
    const restoring = kind.endsWith('restore');
    const entered = heldGate();
    const gate = heldGate();
    const finished = heldGate();
    const secret = 'pending-video-provider-token-123';
    const handle = secrets.get('pendingVideoToken');
    let resolveSecret!: () => Promise<string>;
    const fake = createFakeEngine({ video: true, secrets: [handle],
      onStartAttempt: (context) => { resolveSecret = () => context.resolveSecret(handle); },
      onDispose: async () => { await resolveSecret(); },
    });
    const uploads: string[] = [];
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', cleanupTimeout: 30, secrets: { pendingVideoToken: () => secret },
      artifacts: { store: { async put(artifact) { uploads.push(artifact.path); return { ref: artifact.path }; } } },
    }) });
    const session = await opened.openSession({ name: 'pending retention' });
    const videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    const link = fs.link;
    const lstat = fs.lstat;
    const remove = fs.rm;
    const open = fs.open;
    let inode: number | undefined;
    let original: Buffer | undefined;
    let rendered = '';
    let publicUnlinks = 0;
    const staging = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (source === videoPath) {
        inode = statSync(videoPath).ino;
        original = readFileSync(videoPath);
        if (!restoring) {
          entered.resolve();
          await gate.promise;
          try { await link(source, destination); } finally { finished.resolve(); }
          return;
        }
      }
      await link(source, destination);
    });
    const inspection = vi.spyOn(fs, 'lstat').mockImplementation(async (...args) => {
      if (restoring && String(args[0]).includes('.video-recovery-') && !String(args[0]).includes(path.sep + 'claim-') && !existsSync(videoPath)) {
        entered.resolve();
        await gate.promise;
        try { return await lstat(...args); } finally { finished.resolve(); }
      }
      return lstat(...args);
    });
    const deletion = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      const claimed = String(file).includes(path.sep + 'claim-') && String(file).endsWith(path.sep + 'segment');
      if (claimed) publicUnlinks++;
      await remove(file, options);
      if (restoring && claimed) throw new Error('discard failed after unlink');
    });
    const reservation = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(session.tracePath + '.')) {
        const write = file.writeFile.bind(file);
        vi.spyOn(file, 'writeFile').mockImplementation(async (content) => {
          rendered = String(content);
          expect(fake.stats().disposes).toBe(1);
          expect(rendered).toContain('CLEANUP_TIMEOUT');
          expect(rendered).not.toContain(secret);
          expect(rendered).not.toContain('External test:');
          expect(rendered).not.toContain('- [video](');
          await write(content);
        });
      }
      return file;
    });
    syncBuiltinESMExports();
    const external = { actual: 'passed' as const, retryIndex: 2, testId: secret };
    const closing = session.close({ outcome: external });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      expect(session.outcome()).toBeUndefined();
      expect(rendered).toBe('');
      expect(existsSync(session.tracePath)).toBe(false);
      expect(session.close({ outcome: { actual: 'skipped' } })).toBe(closing);
      const failures = await Promise.race([closing, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('close exceeded bounded retention cleanup')), 300);
      })]);
      expect(failures).toContainEqual(expect.objectContaining({ code: 'CLEANUP_TIMEOUT', phase: 'cleanup' }));
      expect(session.outcome()).toEqual({ status: 'failed', sdkStatus: 'failed', unexpected: true,
        external: { actual: 'passed', retryIndex: 2 } });
      const outcome = session.outcome();
      expect(Object.isFrozen(outcome)).toBe(true);
      expect(await session.close()).toBe(failures);
      expect(rendered).toContain('unexpected');
      expect(readFileSync(session.tracePath, 'utf8')).toBe(rendered);
      expect(uploads).toEqual([]);
      expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
      await opened.close();
      const nextFake = createFakeEngine();
      const next = await host(nextFake.engine);
      expect(await (await next.openSession({ name: 'reservation released while OS work is pending' })).close()).toEqual([]);
      const unlinksAtClose = publicUnlinks;
      expect(unlinksAtClose).toBe(restoring ? 1 : 0);
      if (!kind.startsWith('permanent')) {
        gate.resolve();
        await finished.promise;
        // A task turn drains the abandoned continuation without polling it.
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(publicUnlinks).toBe(unlinksAtClose);
        const recoveryDir = readdirSync(session.artifactsDir).find((name) => name.startsWith('.video-recovery-'))!;
        const recovery = path.join(session.artifactsDir, recoveryDir, 'segment');
        expect(readFileSync(recovery)).toEqual(original);
        expect(statSync(recovery).ino).toBe(inode);
        expect(statSync(recovery).nlink).toBe(restoring ? 1 : 2);
        expect(existsSync(videoPath)).toBe(!restoring);
        if (!restoring) expect(statSync(videoPath).ino).toBe(inode);
        expect(uploads).toEqual([]);
        expect(session.outcome()).toBe(outcome);
        expect(readFileSync(session.tracePath, 'utf8')).toBe(rendered);
      }
    } finally {
      clearTimeout(timer);
      // The permanent cases keep their syscall pending through every close assertion;
      // only test teardown releases it, never a runner timeout or retry.
      gate.resolve();
      await finished.promise;
      await closing;
      await new Promise<void>((resolve) => setImmediate(resolve));
      staging.mockRestore(); inspection.mockRestore(); deletion.mockRestore(); reservation.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('bounds pending private release without retiring a clean worker or changing the frozen verdict', async () => {
    const gate = heldGate();
    const entered = heldGate();
    const finished = heldGate();
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure', cleanupTimeout: 30 }) });
    const session = await opened.openSession({ name: 'pending private release' });
    const rmdir = fs.rmdir;
    const release = vi.spyOn(fs, 'rmdir').mockImplementation(async (directory) => {
      if (String(directory).startsWith(session.artifactsDir) && !String(directory).includes(path.sep + 'claim-')) {
        entered.resolve();
        await gate.promise;
        try { await rmdir(directory); } finally { finished.resolve(); }
      } else await rmdir(directory);
    });
    syncBuiltinESMExports();
    const closing = session.close({ outcome: { actual: 'passed', testId: 'cleanup-maintenance' } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await entered.promise;
      expect(existsSync(session.tracePath)).toBe(true);
      expect(session.outcome()).toBeUndefined();
      const failures = await Promise.race([closing, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('private release exceeded cleanup budget')), 300);
      })]);
      expect(failures).toEqual([]);
      const outcome = session.outcome();
      expect(outcome).toMatchObject({ status: 'passed', sdkStatus: 'passed', unexpected: false });
      expect(fake.stats().disposes).toBe(0);
      expect(await (await opened.openSession({ name: 'worker idle only after bounded release' })).close()).toEqual([]);
      gate.resolve();
      await finished.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(session.outcome()).toBe(outcome);
    } finally {
      clearTimeout(timer);
      gate.resolve();
      await finished.promise;
      await closing;
      release.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('finalizes returned segments after worker retirement without calling the producer again', async () => {
    let videoPath = '';
    const fake = createFakeEngine({ video: true, onEndAttempt: () => { throw new Error('retire this worker'); },
      onDispose: () => {
        expect(stopping).toHaveBeenCalledTimes(1);
        expect(readFileSync(videoPath).length).toBeGreaterThan(1);
      },
    });
    const stopping = vi.spyOn(fake.engine.artifacts!, 'stopVideo');
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'retention is not another producer stop' });
    videoPath = path.join(session.artifactsDir, 'video/fake.webm');
    const failures = await session.close({ outcome: { actual: 'passed' } });
    expect(failures).toContainEqual(expect.objectContaining({ message: 'attempt end failed: retire this worker', phase: 'cleanup' }));
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).toContain('- [video](');
    expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
    expect(await session.close()).toBe(failures);
  });

  it('reports a transient producer stop failure before ending and retiring the worker', async () => {
    const order: string[] = [];
    const fake = createFakeEngine({ video: true, onEndAttempt: () => { order.push('end'); }, onDispose: () => { order.push('dispose'); } });
    const stopping = vi.spyOn(fake.engine.artifacts!, 'stopVideo').mockImplementationOnce(async () => {
      order.push('stop');
      throw new Error('transient producer stop');
    });
    const opened = await host(fake.engine, { config: config(fake.engine, { video: 'retain-on-failure' }) });
    const session = await opened.openSession({ name: 'producer failure is not deferred retention retry' });
    const failures = await session.close({ outcome: { actual: 'passed' } });
    expect(failures).toContainEqual(expect.objectContaining({ message: 'video recording failed: transient producer stop', phase: 'cleanup' }));
    expect(order).toEqual(['stop', 'end', 'dispose']);
    expect(stopping).toHaveBeenCalledTimes(1);
    expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
    expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
    expect(await session.close()).toBe(failures);
  });

  it('claims close before abandoned-step callbacks can reenter it or release the reservation', async () => {
    const enteredCleanup = heldGate();
    const releaseCleanup = heldGate();
    const fake = createFakeEngine({ fixtures: true, onEndAttempt: async () => {
      enteredCleanup.resolve();
      await releaseCleanup.promise;
    } });
    const opened = await host(fake.engine);
    let session!: E2ESession<GadgetFixtures>;
    let reentrant: ReturnType<typeof session.close> | undefined;
    session = await opened.openSession({ name: 'reentrant close', onStep(progress) {
      if (progress.phase === 'end') reentrant = session.close({ outcome: { actual: 'passed' } });
    } });
    session.fixtures.gadget.hang();
    const first = session.close({ outcome: { actual: 'failed', testId: 'first' } });
    await enteredCleanup.promise;
    expect(reentrant).toBe(first);
    expect(session.outcome()).toBeUndefined();
    await expect(opened.openSession({ name: 'overlap' })).rejects.toMatchObject({ code: 'WORKER_PROTOCOL' });
    releaseCleanup.resolve();
    await first;
    expect(session.outcome()?.external).toEqual({ actual: 'failed', testId: 'first' });
    expect(fake.stats().attemptsEnded).toBe(1);
    const next = await opened.openSession({ name: 'after cleanup' });
    expect(await next.close()).toEqual([]);
  });

  it('redacts and escapes external identity without using it as a path', async () => {
    const secret = 'external-test-secret-123';
    const fake = createFakeEngine();
    const opened = await host(fake.engine, { config: config(fake.engine, { secrets: { token: secret } }) });
    const session = await opened.openSession({ name: 'safe name' });
    await session.close({ outcome: { actual: 'failed', testId: '../<script>\u001b[31m' + secret } });
    const trace = readFileSync(session.tracePath, 'utf8');
    expect(trace).not.toContain(secret);
    expect(trace).toContain('External test: `../<script>');
    expect(trace).not.toContain('\u001b');
    expect(session.outcome()?.external?.testId).not.toContain(secret);
    expect(session.artifactsDir).not.toContain('<script>');
  });
});
