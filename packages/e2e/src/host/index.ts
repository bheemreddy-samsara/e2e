/**
 * The `e2e/host` entrypoint: one e2e session opened from another test runner.
 * A host (Playwright Test, Vitest, Jest, a custom harness) keeps its own
 * collection, retries, and reporting, and borrows what e2e owns per attempt:
 * the target's engine provisioning and device or browser leasing, the
 * fixture graph (`agent`, `app`, `screen`, and what the engine contributes),
 * secret redaction, and cleanup. This is the same attempt `e2e mcp` opens; a
 * host gets its fixtures instead of a tool catalog.
 */

import { loadProjectConfig, locateProjectConfig } from '../mcp/config.ts';
import { ConfigurationError, type SerializedError } from '../internal/errors.ts';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { allocateAppPorts } from '../run/app-ports.ts';
import { registerStaticSecrets } from '../run/secrecy.ts';
import { openStandaloneAttempt } from '../run/standalone.ts';
import type { StepProgress, StepRecord } from '../run/steps.ts';
import type { TestFixtures } from '../types.ts';

export type { StepProgress, StepRecord } from '../run/steps.ts';
export type { SerializedError } from '../internal/errors.ts';

export interface OpenSessionOptions {
  /** Directory the config is looked up from; default `process.cwd()`. */
  readonly cwd?: string;
  /** Config file relative to `cwd`; default the nearest `e2e.config.ts` from `cwd` upward. */
  readonly config?: string;
  /** Target to open by name; may be left out when the config declares one target. */
  readonly target?: string;
  /** Configured agent the `agent` fixture runs as when a call names none; default the config's first. */
  readonly agent?: string;
  /** The session's environment, where config, engines, and providers read secrets; default `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Cancels the session wherever it is: provisioning, launch, or a fixture call. */
  readonly signal?: AbortSignal;
  /** How long the session may live, in milliseconds; every fixture operation is capped by it. Default the config's `timeout`. */
  readonly timeout?: number;
  /** Runs a browser engine headed. */
  readonly headed?: boolean;
  /**
   * Live progress of every step the session runs, the same feed `e2e run`
   * reporters get as `step` events: a step opening, its events and
   * activities, and its end with status, duration, and redacted error.
   * Must not block or throw.
   */
  readonly onStep?: (progress: StepProgress) => void;
  /** One line of progress outside any step: engine provisioning, a leased device, an app process. */
  readonly onNotice?: (target: string, message: string) => void;
}

/** One open session: a test attempt with no test body, driven by the host. */
export interface HostSession<Fixtures extends object = Record<string, unknown>> extends AsyncDisposable {
  readonly runId: string;
  readonly attemptId: string;
  /** The target the session runs on, by name. */
  readonly target: string;
  /** `agent`, `app`, `screen`, `platform`, and the engine's fixtures (`browser`, `device`). */
  readonly fixtures: TestFixtures & Fixtures;
  /** Absolute directory the session's artifacts (screenshots, recordings) are written to. */
  readonly artifactsDir: string;
  /** The steps run so far, finished ones and the one running, as the report records them. */
  steps(): readonly StepRecord[];
  /**
   * Ends the session: closes the engine session, releases leased devices or
   * browsers, stops app processes, and resolves with the cleanup failures
   * instead of throwing them. Idempotent.
   */
  close(): Promise<readonly SerializedError[]>;
}

/**
 * Opens one session on a target of the project's config. On any failure
 * everything that did start is torn down before the error surfaces.
 *
 * ```ts
 * import { openSession } from 'e2e/host';
 * import type { Device } from '@e2e-dev/mobile';
 *
 * await using session = await openSession<{ device: Device }>({ target: 'android' });
 * await session.fixtures.agent.act('open settings and turn on dark mode');
 * ```
 */
export async function openSession<Fixtures extends object = Record<string, unknown>>(
  options: OpenSessionOptions = {},
): Promise<HostSession<Fixtures>> {
  const env = options.env ?? process.env;
  const configPath = locateProjectConfig({ cwd: options.cwd ?? process.cwd(), configPath: options.config });
  const loaded = await loadProjectConfig(configPath, env);
  // Known to the process before anything can fail with one, as in a run.
  registerStaticSecrets(loaded.allSecrets);
  // A session is its own run: a URL declared with port 0 gets a port here.
  const config = await allocateAppPorts(loaded);
  const target = resolveTarget(config, options.target);
  const attempt = await openStandaloneAttempt({
    config,
    target,
    headed: options.headed ?? false,
    env,
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeout ?? config.timeout,
    agent: options.agent,
    ...(options.onNotice === undefined ? {} : { notice: options.onNotice }),
    ...(options.onStep === undefined ? {} : { onProgress: options.onStep }),
  });
  const close = (): Promise<readonly SerializedError[]> => attempt.close();
  return {
    runId: attempt.runId,
    attemptId: attempt.attemptId,
    target: target.name,
    fixtures: attempt.fixtures as TestFixtures & Fixtures,
    artifactsDir: attempt.artifactsDir,
    steps: () => attempt.steps.all(),
    close,
    [Symbol.asyncDispose]: async () => {
      await close();
    },
  };
}

function resolveTarget(config: ResolvedConfig, name: string | undefined): ResolvedTarget {
  const names = config.targets.map((target) => `"${target.name}"`).join(', ');
  if (name !== undefined) {
    const target = config.targets.find((candidate) => candidate.name === name);
    if (target === undefined) throw new ConfigurationError('UNKNOWN_TARGET', `unknown target "${name}"; the config declares ${names}`);
    return target;
  }
  const [only] = config.targets;
  if (only === undefined) throw new ConfigurationError('INVALID_CONFIG', 'the config declares no targets');
  if (config.targets.length > 1) throw new ConfigurationError('TARGET_REQUIRED', `the config declares several targets (${names}); pass \`target\` to openSession`);
  return only;
}
