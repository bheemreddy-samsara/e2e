import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareTextReport, writeJsonReport } from '../../src/report/write.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('writeJsonReport', () => {
  it('creates missing parent directories', async () => {
    const file = path.join(dir, 'deep', 'nested', 'report.json');
    await writeJsonReport(file, []);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([]);
  });

  it('atomically replaces an existing report', async () => {
    const file = path.join(dir, 'report.json');
    await writeJsonReport(file, { version: 1 });
    await writeJsonReport(file, { version: 2 });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 2 });
    expect(readdirSync(dir)).toEqual(['report.json']);
  });
});

describe('prepareTextReport', () => {
  it('reserves an empty temporary without publishing a trace or document bytes', async () => {
    const file = path.join(dir, 'nested', 'trace.md');
    const prepared = await prepareTextReport(file);
    expect(existsSync(file)).toBe(false);
    const temporary = readdirSync(path.dirname(file));
    expect(temporary).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(file), temporary[0]!), 'utf8')).toBe('');
    await prepared.publish('safe finalized trace');
    expect(readFileSync(file, 'utf8')).toBe('safe finalized trace');
    expect(readdirSync(path.dirname(file))).toEqual(['trace.md']);
    await prepared.discard();
  });

  it('discards an unpublished reservation idempotently', async () => {
    const prepared = await prepareTextReport(path.join(dir, 'trace.md'));
    await prepared.discard();
    await prepared.discard();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('rejects a directory destination before reserving persistence', async () => {
    const file = path.join(dir, 'trace.md');
    mkdirSync(file);
    await expect(prepareTextReport(file)).rejects.toThrow('report destination is a directory');
    expect(readdirSync(dir)).toEqual(['trace.md']);
  });
});
