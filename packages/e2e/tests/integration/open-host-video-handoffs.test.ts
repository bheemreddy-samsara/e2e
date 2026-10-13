/** Public close with synthetic OS handoff faults and an ordinary recording producer. */
import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createFakeEngine } from '../helpers/fake-engine.ts';
import { hostHarness } from '../helpers/open-host.ts';

describe('openHost: video path handoffs', () => {
  const { host, config } = hostHarness();

  it('recovers the original while preserving a producer replacement claimed at discard', async () => {
    const uploads: Buffer[] = [];
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', artifacts: { store: { async put(artifact) {
        uploads.push(Buffer.from(artifact.bytes)); return { ref: artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'producer replaces finalized path' });
    const video = path.join(session.artifactsDir, 'video/fake.webm');
    const nextBytes = Buffer.from('complete next producer recording');
    let original: Buffer | undefined;
    let originalInode = 0;
    let nextInode = 0;
    let replacements = 0;
    const replace = (): void => {
      replacements++;
      original = readFileSync(video);
      originalInode = statSync(video).ino;
      const next = path.join(session.artifactsDir, 'next');
      writeFileSync(next, nextBytes);
      nextInode = statSync(next).ino;
      renameSync(next, video);
    };
    const rename = fs.rename;
    const remove = fs.rm;
    const moving = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (source === video) replace();
      await rename(source, destination);
    });
    const deleting = vi.spyOn(fs, 'rm').mockImplementation(async (file, options) => {
      if (file === video) replace();
      await remove(file, options);
    });
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'passed' } });
      expect(replacements).toBe(1);
      expect(original?.length).toBeGreaterThan(1);
      expect(readFileSync(video)).toEqual(original);
      expect(failures).toContainEqual(expect.objectContaining({ phase: 'cleanup' }));
      expect(statSync(video).ino).toBe(originalInode);
      expect(statSync(video).nlink).toBe(1);
      const files = readdirSync(session.artifactsDir, { recursive: true }).map((file) => path.join(session.artifactsDir, String(file))).filter((file) => statSync(file).isFile());
      const next = files.find((file) => statSync(file).ino === nextInode)!;
      expect(readFileSync(next)).toEqual(nextBytes);
      expect(statSync(next).nlink).toBe(1);
      expect(files.filter((file) => !file.endsWith('trace.md'))).toHaveLength(2);
      expect(uploads).toEqual([original]);
      expect(readFileSync(session.tracePath, 'utf8')).toContain('- [video](');
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
      expect(await session.close()).toBe(failures);
    } finally {
      moving.mockRestore(); deleting.mockRestore(); syncBuiltinESMExports();
    }
  });

  it('keeps both complete inodes when a producer creates the recovery destination after inspection', async () => {
    const uploads: Buffer[] = [];
    const fake = createFakeEngine({ video: true });
    const opened = await host(fake.engine, { config: config(fake.engine, {
      video: 'retain-on-failure', artifacts: { store: { async put(artifact) {
        uploads.push(Buffer.from(artifact.bytes)); return { ref: artifact.path };
      } } },
    }) });
    const session = await opened.openSession({ name: 'producer races recovery' });
    const video = path.join(session.artifactsDir, 'video/fake.webm');
    const next = Buffer.from('complete racing producer recording');
    let nextInode = 0;
    let originalInode = 0;
    let original: Buffer | undefined;
    let created = 0;
    const link = fs.link;
    const rename = fs.rename;
    const open = fs.open;
    const create = (): void => {
      created++;
      writeFileSync(video, next);
      nextInode = statSync(video).ino;
    };
    const linking = vi.spyOn(fs, 'link').mockImplementation(async (source, destination) => {
      if (source === video) { original = readFileSync(video); originalInode = statSync(video).ino; }
      if (destination === video) create();
      await link(source, destination);
    });
    const moving = vi.spyOn(fs, 'rename').mockImplementation(async (source, destination) => {
      if (destination === video) create();
      await rename(source, destination);
    });
    const publication = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const file = await open(...args);
      if (String(args[0]).startsWith(session.tracePath + '.')) {
        vi.spyOn(file, 'writeFile').mockRejectedValue(Object.assign(new Error('synthetic publication ENOSPC'), { code: 'ENOSPC' }));
      }
      return file;
    });
    syncBuiltinESMExports();
    try {
      const failures = await session.close({ outcome: { actual: 'passed' } });
      expect(created).toBe(1);
      expect(readFileSync(video)).toEqual(next);
      expect(statSync(video).ino).toBe(nextInode);
      expect(statSync(video).nlink).toBe(1);
      const directory = readdirSync(session.artifactsDir).find((file) => file.startsWith('.video-recovery-'))!;
      const backup = path.join(session.artifactsDir, directory, 'segment');
      expect(original?.length).toBeGreaterThan(1);
      expect(readFileSync(backup)).toEqual(original);
      expect(statSync(backup).ino).toBe(originalInode);
      expect(statSync(backup).nlink).toBe(1);
      expect(uploads).toEqual([]);
      expect(failures.length).toBeGreaterThan(1);
      expect(existsSync(session.tracePath)).toBe(false);
      expect(session.outcome()).toMatchObject({ sdkStatus: 'failed', unexpected: true });
      expect(fake.stats()).toMatchObject({ attemptsEnded: 1, disposes: 1 });
      expect(await session.close()).toBe(failures);
    } finally {
      linking.mockRestore(); moving.mockRestore(); publication.mockRestore(); syncBuiltinESMExports();
    }
  });
});
