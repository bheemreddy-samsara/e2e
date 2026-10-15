/** The per-session `trace.md` a hosted attempt writes at close, through the run report's renderer. */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ResolvedConfig, ResolvedTarget } from '../config/resolve.ts';
import { buildReport, type Report1Document, type ReportError } from '../report/build.ts';
import { truncateUtf8 } from '../internal/errors.ts';
import { bound } from '../internal/text.ts';
import { redactReportTurn } from './turn-cuts.ts';
import { renderTracePage } from '../report/failure-text.ts';
import { outcome } from '../report/outcome.ts';
import { toPosixPath, writeTextReport } from '../report/write.ts';
import type { AttemptRecord, ResultRecord } from './records.ts';

export interface HostTraceOptions {
  readonly config: ResolvedConfig;
  readonly target: ResolvedTarget;
  readonly runId: string;
  readonly testId: string;
  /** The session name, already redacted. */
  readonly title: string;
  readonly agent: string;
  readonly attempt: AttemptRecord;
  /** The results directory the page's artifact links resolve against. */
  readonly resultsDir: string;
  /** Path segments of the attempt's directory under `resultsDir`. */
  readonly segments: readonly string[];
  readonly tracePath: string;
  readonly redact: (text: string) => string;
  readonly redactCut?: (text: string) => string;
  readonly redactFragments?: (text: string) => string;
}

/** Writes one session's trace page as a single-result run, so it reads like `e2e run`'s. */
export async function writeHostTrace(options: HostTraceOptions): Promise<Report1Document> {
  const { config, attempt, title } = options;
  const status = attempt.status;
  const result: ResultRecord = {
    test: { id: options.testId, kind: 'test', title, titlePath: [title], file: 'host', declarationIndex: 0, sessions: [], tags: [], source: undefined, serialId: undefined },
    target: options.target, agent: options.agent, repeat: 0, selected: true, status, attempts: [attempt],
  };
  const original = buildReport({
    config, runId: options.runId, startedAt: attempt.startedAt,
    status: status === 'interrupted' ? 'interrupted' : status === 'passed' ? 'passed' : 'failed',
    exitCode: status === 'interrupted' ? 130 : status === 'passed' ? 0 : 1,
    results: [result], serialGroups: [], runErrors: [], targetProvenance: new Map(),
  });
  const report = redactHostReport(original, options);
  const reported = report.run.results[0]!;
  const page = renderTracePage(report, reported, outcome(reported, new Map()), {
    standalone: true,
    artifactsDir: toPosixPath(path.relative(config.projectRoot, options.resultsDir)),
    pageDir: toPosixPath(path.join(...options.segments)),
    readArtifact: (reportPath) => {
      try { return readFileSync(path.join(options.resultsDir, reportPath), 'utf8'); } catch { return undefined; }
    },
  });
  await writeTextReport(options.tracePath, options.redact(page));
  return report;
}

/** Constructs the hosted snapshot at typed prose slots, leaving report facts untouched. */
function redactHostReport(original: Report1Document, options: HostTraceOptions): Report1Document {
  const report = structuredClone(original);
  const { redact } = options;
  const redactCut = options.redactCut ?? redact;
  const fragments = options.redactFragments ?? redact;
  const text = (value: string, max = Infinity): string => bound(redact(value), max);
  const clipped = (value: string, max: number): string => bound(
    (value.length === max || value.length === max - 1) && value.endsWith('…') ? redactCut(value.slice(0, -1)) + '…' : redact(value), max);
  const bytes = (value: string, max: number): string => truncateUtf8(
    Buffer.byteLength(value) >= max - 3 ? redactCut(value) : redact(value), max);
  const source = (value: { file: string }): void => { if (redact(value.file) !== value.file) value.file = 'unknown'; };
  const error = (value: ReportError | undefined): void => {
    if (value === undefined) return;
    value.message = bytes(value.message, 8192);
    if (value.scopeId !== undefined) value.scopeId = text(value.scopeId, 1024);
    if (value.source !== undefined) source(value.source);
    if (value.details !== undefined) value.details = {
      ...value.details,
      ...Object.fromEntries(Object.entries(value.details).map(([key, entry]) =>
        [key, typeof entry === 'string' ? bytes(entry, 2048) : entry])),
    };
  };
  const { run } = report;
  run.project.id = text(run.project.id, 256);
  run.runner.version = text(run.runner.version);
  run.environment.os = text(run.environment.os);
  run.environment.arch = text(run.environment.arch);
  run.environment.runtime = text(run.environment.runtime);
  for (const target of run.targets) {
    target.id = text(target.id);
    target.platform = text(target.platform);
    target.engine.name = text(target.engine.name, 256);
    target.engine.version = text(target.engine.version, 128);
    if (target.baseOrigin !== undefined && redact(target.baseOrigin) !== target.baseOrigin) delete target.baseOrigin;
  }
  for (const [ri, result] of run.results.entries()) {
    result.titlePath = result.titlePath.map((part) => text(part));
    result.targetId = text(result.targetId);
    result.platform = text(result.platform);
    result.agent = text(result.agent);
    source(result.source);
    for (const [ai, attempt] of result.attempts.entries()) {
      error(attempt.error);
      attempt.secondaryErrors.forEach(error);
      for (const artifact of attempt.artifacts) {
        artifact.mediaType = text(artifact.mediaType);
        if (artifact.ref !== undefined) artifact.ref = text(artifact.ref);
        if (artifact.url !== undefined && redact(artifact.url) !== artifact.url) delete artifact.url;
      }
      if (attempt.appLog !== undefined) attempt.appLog = attempt.appLog.map((log) => ({ ...log, text: clipped(log.text, 300) }));
      for (const [si, step] of attempt.steps.entries()) {
        step.api = text(step.api);
        step.label = text(step.label, 8192);
        source(step.source);
        error(step.error);
        if (step.agent !== undefined) step.agent = text(step.agent);
        if (step.observationRevision !== undefined) step.observationRevision = text(step.observationRevision, 256);
        if (step.explanation !== undefined) step.explanation = text(step.explanation, 8192);
        if (step.cache?.detail !== undefined) step.cache.detail = clipped(step.cache.detail, 600);
        if (step.screen !== undefined) {
          if (step.screen.location !== undefined) step.screen.location = text(step.screen.location);
          step.screen.changes = step.screen.changes.map((change) => clipped(change, 200));
        }
        if (step.model !== undefined) {
          step.model.provider = text(step.model.provider);
          step.model.model = text(step.model.model);
          step.model.adapterVersion = text(step.model.adapterVersion);
          step.model.policyVersion = text(step.model.policyVersion);
        }
        for (const event of step.events) {
          if (event.name !== undefined) event.name = text(event.name, 256);
          if (event.detail !== undefined) event.detail = clipped(event.detail, 300);
          if (event.reasoning !== undefined) event.reasoning = clipped(event.reasoning, 600);
        }
        const recorded = original.run.results[ri]!.attempts[ai]!.steps[si]!;
        if (recorded.turns !== undefined) step.turns = recorded.turns.map((turn) => {
          const safe = redactReportTurn(turn, { redact, redactCut });
          return {
            index: safe.index,
            calls: safe.calls.map((call) => bound(fragments(call), 512)),
            outcome: bound(fragments(safe.outcome), 2048),
          };
        });
      }
    }
  }
  return report;
}
