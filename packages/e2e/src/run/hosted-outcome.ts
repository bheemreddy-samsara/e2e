/** Bounded external-runner facts, kept separate from the SDK verdict. */
import { ConfigurationError } from '../internal/errors.ts';
import type { AttemptStatus } from './records.ts';

/** Native runners map their vocabulary to these engine-independent statuses. */
export type ExternalStatus = 'passed' | 'failed' | 'timed-out' | 'skipped' | 'interrupted';

export interface ExternalOutcome {
  readonly actual: ExternalStatus;
  /** Defaults to passed. SDK failures are never expected by this annotation. */
  readonly expected?: ExternalStatus | undefined;
  /** Zero-based external retry index. Metadata only; each retry opens its own session. */
  readonly retryIndex?: number | undefined;
  /** Stable external identity, 1-256 UTF-16 code units; redacted or omitted with provider-backed secrets. */
  readonly testId?: string | undefined;
}

export interface CloseSessionOptions {
  readonly outcome?: ExternalOutcome | undefined;
}

export interface HostedSessionOutcome {
  readonly status: ExternalStatus;
  /** Failure-only retention follows this flag, not the external actual status alone. */
  readonly unexpected: boolean;
  readonly sdkStatus: AttemptStatus;
  readonly external?: ExternalOutcome | undefined;
}

const STATUSES = new Set<unknown>(['passed', 'failed', 'timed-out', 'skipped', 'interrupted']);

/** Reads only own data properties: getters, raw errors, causes, and unknown keys are refused. */
function fields(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error();
  const entries = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(entries).some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error();
  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(entries)) {
    if (!('value' in descriptor)) throw new Error();
    result[key] = descriptor.value;
  }
  return result;
}

/** Rejects bad metadata without echoing it; an undefined identity projection withholds that field. */
export function parseCloseOutcome(options: unknown, redact: (text: string) => string | undefined): ExternalOutcome | undefined {
  try {
    if (options === undefined) return undefined;
    const close = fields(options, ['outcome']);
    if (close['outcome'] === undefined) return undefined;
    const value = fields(close['outcome'], ['actual', 'expected', 'retryIndex', 'testId']);
    const { actual, expected, retryIndex, testId } = value;
    if (!STATUSES.has(actual) || (expected !== undefined && !STATUSES.has(expected))) throw new Error();
    if (retryIndex !== undefined && (typeof retryIndex !== 'number' || !Number.isSafeInteger(retryIndex) || retryIndex < 0)) throw new Error();
    if (testId !== undefined && (typeof testId !== 'string' || testId.length === 0 || testId.length > 256)) throw new Error();
    const safeTestId = testId === undefined ? undefined : redact(testId as string)?.slice(0, 256);
    return Object.freeze({
      actual: actual as ExternalStatus,
      ...(expected === undefined ? {} : { expected: expected as ExternalStatus }),
      ...(retryIndex === undefined ? {} : { retryIndex: retryIndex as number }),
      ...(safeTestId === undefined ? {} : { testId: safeTestId }),
    });
  } catch {
    throw new ConfigurationError('INVALID_CONFIG', 'invalid hosted session close outcome: use only bounded status, expected status, retry index, and test identity');
  }
}

/** SDK failures outrank external facts; skips are not unexpected, but unexpected passes are. */
export function hostedOutcome(sdkStatus: AttemptStatus, external: ExternalOutcome | undefined): HostedSessionOutcome {
  const actual = external?.actual ?? 'passed';
  const unexpected = sdkStatus !== 'passed' || (actual !== 'skipped' && actual !== (external?.expected ?? 'passed'));
  const status = sdkStatus !== 'passed' ? sdkStatus : unexpected && actual === 'passed' ? 'failed' : actual;
  return Object.freeze({ status, unexpected, sdkStatus, ...(external === undefined ? {} : { external }) });
}
