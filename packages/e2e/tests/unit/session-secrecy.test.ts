import { describe, expect, it } from 'vitest';
import { secretHandle } from '../../src/secrets.ts';
import type { ResolvedConfig } from '../../src/config/resolve.ts';
import type { TargetSession } from '../../src/engine/surface.ts';
import { serializeError, TestError } from '../../src/internal/errors.ts';
import { adoptSecrecy, carriedSecrecy, hasPendingSecretResolutions, processSecrets, redactForSession, registerStaticSecrets, redactsDownloads, resolveSecretValue, sessionSecrecy, staticSecretLedger, trackSecretResolution } from '../../src/run/secrecy.ts';

const STATIC_VALUE = 'static-config-password-5521';
const PROVIDER_VALUE = 'provider-minted-token-8804';

const secrets: ResolvedConfig['secrets'] = new Map([
  ['password', { name: 'password', purpose: 'password', value: STATIC_VALUE }],
  ['token', { name: 'token', purpose: 'generic-secret', value: () => PROVIDER_VALUE }],
]);

/** A fresh session key; secrecy state is keyed by session identity only. */
function newSession(): TargetSession {
  return {} as unknown as TargetSession;
}

describe('session secrecy carried across save and restore', () => {
  it('carries the provider values and the taint, leaving static values to each session', () => {
    const saving = sessionSecrecy(newSession(), secrets);
    saving.ledger.register('token', PROVIDER_VALUE);
    saving.exposure.raise('filled');
    expect(carriedSecrecy(saving, secrets)).toEqual({ secrets: [['token', PROVIDER_VALUE]], tainted: true });
  });

  it('seeds the restoring session and the process ledger with the carried values, and its taint', () => {
    const restoring = sessionSecrecy(newSession(), secrets);
    const value = 'provider-minted-token-adopted-2290';
    expect(processSecrets.redact(value)).toBe(value);
    adoptSecrecy(restoring, { secrets: [['token', value]], tainted: true });
    expect(restoring.ledger.redact(`echo ${value}`)).toBe('echo <secret:token>');
    expect(processSecrets.redact(`log ${value}`)).toBe('log <secret:token>');
    expect(restoring.exposure.carriesTaint).toBe(true);
  });

  it('never clears a taint the restoring session already carries', () => {
    const restoring = sessionSecrecy(newSession(), secrets);
    restoring.exposure.raise('filled');
    adoptSecrecy(restoring, { secrets: [], tainted: false });
    expect(restoring.exposure.carriesTaint).toBe(true);
  });
});

describe('session exposure', () => {
  it('withholds pixels and carries the taint into a saved session only after a fill', () => {
    const secrecy = sessionSecrecy(newSession(), secrets);
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: false, carriesTaint: false });
    expect(carriedSecrecy(secrecy, secrets).tainted).toBe(false);
    secrecy.exposure.raise('filled');
    expect(secrecy.exposure).toMatchObject({ withholdsPixels: true, carriesTaint: true });
    expect(carriedSecrecy(secrecy, secrets).tainted).toBe(true);
  });

  it('rewrites recordings whenever the ledger holds a value, filled or not', () => {
    expect(redactsDownloads(sessionSecrecy(newSession(), secrets))).toBe(true);
    const unsecret = sessionSecrecy(newSession(), new Map());
    expect(redactsDownloads(unsecret)).toBe(false);
    unsecret.ledger.register('token', PROVIDER_VALUE);
    expect(redactsDownloads(unsecret)).toBe(true);
  });
});

describe('redaction before and after a session opens', () => {
  it('redacts the static values with no session, and every value the session learned once one is open', () => {
    expect(redactForSession(undefined, secrets, `title ${STATIC_VALUE}`)).toBe('title <secret:password>');
    // A provider value is not known before it resolves.
    expect(redactForSession(undefined, secrets, `title ${PROVIDER_VALUE}`)).toBe(`title ${PROVIDER_VALUE}`);
    const session = newSession();
    sessionSecrecy(session, secrets).ledger.register('token', PROVIDER_VALUE);
    expect(redactForSession(session, secrets, `${STATIC_VALUE} ${PROVIDER_VALUE}`)).toBe('<secret:password> <secret:token>');
  });

  it('keeps one static ledger per secrets map, untouched by what a session learns', () => {
    const ledger = staticSecretLedger(secrets);
    expect(staticSecretLedger(secrets)).toBe(ledger);
    sessionSecrecy(newSession(), secrets).ledger.register('token', PROVIDER_VALUE);
    expect(ledger.entries()).toEqual([['password', STATIC_VALUE]]);
  });

  it('makes the process ledger the default redactor once seeded, so a serialized error carries no secret', () => {
    const value = 'process-wide-ledger-value-3391';
    registerStaticSecrets(secrets);
    processSecrets.register('token', value);
    const serialized = serializeError(new TestError('ASSERTION_FAILED', `the app echoed ${value}`));
    expect(serialized.message).toBe('the app echoed <secret:token>');
  });
});

/** Holds a provider or its post-registration handoff without a timer. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('checkpoint ledger completeness', () => {
  it('tracks concurrent providers until each value is registered, without resolving unused providers', async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    let unused = 0;
    const configured: ResolvedConfig['allSecrets'] = new Map([
      ['first', { name: 'first', purpose: 'generic-secret', value: () => first.promise }],
      ['second', { name: 'second', purpose: 'generic-secret', value: () => second.promise }],
      ['unused', { name: 'unused', purpose: 'generic-secret', value: () => { unused++; return 'unused-provider-value'; } }],
    ]);
    const { ledger } = sessionSecrecy(newSession(), configured);
    const a = resolveSecretValue(secretHandle({ name: 'first', purpose: 'generic-secret' }), configured, ledger);
    const b = resolveSecretValue(secretHandle({ name: 'second', purpose: 'generic-secret' }), configured, ledger);
    expect(hasPendingSecretResolutions(ledger)).toBe(true);
    first.resolve('first-provider-value');
    await a;
    expect(ledger.redact('first-provider-value')).toBe('<secret:first>');
    expect(hasPendingSecretResolutions(ledger)).toBe(true);
    second.resolve('second-provider-value');
    await b;
    expect(ledger.redact('second-provider-value')).toBe('<secret:second>');
    expect(hasPendingSecretResolutions(ledger)).toBe(false);
    expect(unused).toBe(0);
  });

  it('keeps a resolution pending through the engine-derived or fill-taint handoff', async () => {
    const { ledger, exposure } = sessionSecrecy(newSession(), secrets);
    const handoff = deferred<void>();
    const registered = deferred<void>();
    const resolving = trackSecretResolution(ledger, async () => {
      const value = await resolveSecretValue(secretHandle({ name: 'token', purpose: 'generic-secret' }), secrets, ledger);
      registered.resolve();
      await handoff.promise;
      ledger.register('token', 'derived-' + value);
      exposure.raise('filled');
      return value;
    });
    await registered.promise;
    expect(ledger.redact(PROVIDER_VALUE)).toBe('<secret:token>');
    expect(hasPendingSecretResolutions(ledger)).toBe(true);
    handoff.resolve();
    await resolving;
    expect(hasPendingSecretResolutions(ledger)).toBe(false);
    expect(ledger.redact('derived-' + PROVIDER_VALUE)).toBe('<secret:token>');
    expect(exposure.withholdsPixels).toBe(true);
  });

  it('clears a rejected resolution and keeps other session ledgers independent', async () => {
    const { ledger } = sessionSecrecy(newSession(), secrets);
    const other = sessionSecrecy(newSession(), secrets);
    const provider = deferred<void>();
    const resolving = trackSecretResolution(ledger, async () => {
      await provider.promise;
      throw new Error('provider unavailable');
    });
    expect(hasPendingSecretResolutions(ledger)).toBe(true);
    expect(hasPendingSecretResolutions(other.ledger)).toBe(false);
    provider.resolve();
    await expect(resolving).rejects.toThrow('provider unavailable');
    expect(hasPendingSecretResolutions(ledger)).toBe(false);
  });

  it('clears a synchronous provider failure without eagerly retrying it', async () => {
    const { ledger } = sessionSecrecy(newSession(), secrets);
    let calls = 0;
    const resolving = trackSecretResolution(ledger, () => {
      calls++;
      throw new Error('synchronous failure');
    });
    await expect(resolving).rejects.toThrow('synchronous failure');
    expect(hasPendingSecretResolutions(ledger)).toBe(false);
    expect(calls).toBe(1);
  });
});
