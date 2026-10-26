/**
 * A trusted test engine returns constant, secret-free pixels. It tests the
 * runner's proof gate, not a redaction implementation or a seeing model.
 */
import { describe, expect, it } from 'vitest';
import type { EngineObserveOptions } from '../../src/engine/index.ts';
import { EngineError } from '../../src/engine/contract.ts';
import { createFakeEngine, FAKE_APP } from '../helpers/fake-engine.ts';
import { fakeCalls, installFakeModel, judgment } from '../helpers/fake-model.ts';
import { contentsUnder, resultByTitle, runProject } from '../helpers/run-project.ts';

const SECRET = 'post-secret-fixture-password';
const PIXELS = {
  data: new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jQioAAAAASUVORK5CYII=', 'base64')),
  mediaType: 'image/png' as const, width: 1, height: 1, scale: 1,
};
const OPT_IN = "{ vision: 'only', screenshotPolicy: 'redacted-after-secrets' }";

function suite(options = OPT_IN, second?: string): string {
  return `import { test, credentials } from 'e2e';
test('post-secret judgment', async ({ app, screen, agent }) => {
  await app.open();
  await screen.getByRole('textbox', { name: 'Password' }).fill(credentials.user('member').password);
  await agent.assert('ready', ${options});
  ${second === undefined ? '' : `await agent.assert('still ready', ${second});`}
});`;
}

type Proof = (options: EngineObserveOptions) => string | undefined;

/** Exercises the built runner with secret filling and the public engine SPI. */
async function exercise(proof: Proof, assertOptions = OPT_IN, second?: string, masks = 1, complete = true) {
  const challenges: string[] = [];
  const engine = createFakeEngine({
    scene: () => [{ id: 'password', role: 'textbox', name: 'Password', inputPurpose: 'password', states: { secure: true } }],
    pixels: options => {
      const challenge = options.secretRedactionChallenge;
      if (challenge !== undefined) challenges.push(challenge);
      const attested = proof(options);
      const evidence = attested === undefined ? undefined : { challenge: attested, complete: true as const };
      if (evidence !== undefined && !complete) Object.defineProperty(evidence, 'complete', { value: false });
      return {
        pixels: PIXELS, maskedRegionCount: masks,
        ...(evidence === undefined ? {} : { secretRedaction: evidence }),
      };
    },
  });
  const model = installFakeModel(() => judgment(true, 'ready'));
  const { outcome, project } = await runProject({ 'tests/check.e2e.ts': suite(assertOptions, second) }, {
    config: {
      targets: [{ name: 'test', platform: 'fake', engine: engine.engine, app: FAKE_APP }],
      agents: { default: { model } },
      credentials: { member: { username: 'test', password: SECRET } },
      cache: 'off',
    },
  });
  try {
    const result = resultByTitle(outcome, 'post-secret judgment');
    const steps = result.attempts[0]!.steps.filter(step => step.api === 'agent.assert');
    for (const [, data] of contentsUnder(project.dir)) expect(data).not.toContain(SECRET);
    return { result, steps, calls: [...fakeCalls], challenges };
  } finally {
    project.cleanup();
  }
}

describe('capture-bound post-secret assertion policy', () => {
  it('sends only attested pixels, with normal model-input reporting', async () => {
    const run = await exercise(options => options.secretRedactionChallenge);
    expect(run.result.status).toBe('passed');
    expect(run.challenges).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({ status: 'passed', visionInput: true, visionOnly: true });
    expect(run.calls).toHaveLength(1);
    expect(run.calls[0]!.images).toHaveLength(1);
    expect(run.calls[0]!.observation).toBe('');
  });

  it.each([
    ['missing', (): string | undefined => undefined],
    ['unrelated', (): string => 'an-earlier-capture'],
  ] as const)('denies %s proof before any model call', async (_name, proof) => {
    const run = await exercise(proof);
    expect(run.steps[0]).toMatchObject({ status: 'failed', error: { code: 'POLICY_DENIED' }, visionDegraded: 'PIXEL_TAINTED' });
    expect(run.calls).toHaveLength(0);
  });

  it('rejects incomplete evidence from an untyped engine', async () => {
    const run = await exercise(options => options.secretRedactionChallenge, OPT_IN, undefined, 1, false);
    expect(run.calls).toHaveLength(0);
    expect(run.steps[0]).toMatchObject({ status: 'failed', visionDegraded: 'PIXEL_TAINTED' });
  });

  it('uses a fresh challenge when a capture is retried', async () => {
    let first: string | undefined;
    const run = await exercise(options => {
      if (first === undefined) {
        first = options.secretRedactionChallenge;
        throw new EngineError('NODE_STALE', 'capture raced', { retryable: true });
      }
      return first;
    });
    expect(new Set(run.challenges).size).toBe(2);
    expect(run.calls).toHaveLength(0);
    expect(run.steps[0]).toMatchObject({ status: 'failed', visionDegraded: 'PIXEL_TAINTED' });
  });

  it('still requires every secure field to be masked', async () => {
    const run = await exercise(options => options.secretRedactionChallenge, OPT_IN, undefined, 0);
    expect(run.steps[0]).toMatchObject({ status: 'failed', visionDegraded: 'MASKING_UNPROVEN' });
    expect(run.calls).toHaveLength(0);
  });

  it('does not clear taint for the next assertion', async () => {
    const run = await exercise(options => options.secretRedactionChallenge, OPT_IN, "{ vision: 'only' }");
    expect(run.steps[0]!.status).toBe('passed');
    expect(run.steps[1]).toMatchObject({ status: 'failed', visionDegraded: 'PIXEL_TAINTED' });
    expect(run.calls).toHaveLength(1);
  });

  it('rejects an earlier assertion’s proof on a fresh capture', async () => {
    let previous: string | undefined;
    const run = await exercise(options => {
      if (options.secretRedactionChallenge === undefined) return undefined;
      previous ??= options.secretRedactionChallenge;
      return previous;
    }, OPT_IN, OPT_IN);
    expect(new Set(run.challenges).size).toBe(2);
    expect(run.steps[0]!.status).toBe('passed');
    expect(run.steps[1]).toMatchObject({ status: 'failed', visionDegraded: 'PIXEL_TAINTED' });
    expect(run.calls).toHaveLength(1);
  });

  it('rejects custom executors before calling them', async () => {
    let called = false;
    const { outcome, project } = await runProject({
      'tests/custom.e2e.ts': `import { test } from 'e2e';
test('custom policy', async ({ agent }) => { await agent.assert('ready', ${OPT_IN}); });`,
    }, {
      config: { agents: { default: { executor: {
        name: 'custom', vision: true,
        async runStep() { called = true; return { status: 'passed', summary: 'ready' }; },
      } } } },
    });
    try {
      expect(resultByTitle(outcome, 'custom policy').attempts[0]!.error?.code).toBe('UNSUPPORTED_CAPABILITY');
      expect(called).toBe(false);
    } finally {
      project.cleanup();
    }
  });

  it('does not request proof or relax the default assertion', async () => {
    const run = await exercise(options => options.secretRedactionChallenge, "{ vision: 'only' }");
    expect(run.challenges).toHaveLength(0);
    expect(run.calls).toHaveLength(0);
    expect(run.steps[0]).toMatchObject({ status: 'failed', visionDegraded: 'PIXEL_TAINTED' });
  });

  it.each(["{ vision: true, screenshotPolicy: 'redacted-after-secrets' }", "{ vision: 'only', screenshotPolicy: 'unsafe' }"])(
    'rejects invalid policy combinations: %s', async assertOptions => {
      const run = await exercise(options => options.secretRedactionChallenge, assertOptions);
      expect(run.result.attempts[0]!.error?.code).toBe('INVALID_ARGUMENT');
      expect(run.calls).toHaveLength(0);
    },
  );
});
