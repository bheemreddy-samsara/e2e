import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import promises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoDiscard } from '../../src/run/video-discard.ts';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'e2e-video-discard-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('VideoDiscard', () => {
  it('recovers exact bytes after concurrent duplicate discards and repeated recovery', async () => {
    const file = path.join(dir, 'video.webm');
    const bytes = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xff, 0x00]);
    writeFileSync(file, bytes);
    const discarded = new VideoDiscard(dir);
    try {
      await Promise.all([discarded.discard(file), discarded.discard(file)]);
      expect(existsSync(file)).toBe(false);
      await discarded.restore();
      expect(readFileSync(file)).toEqual(bytes);
      await discarded.restore();
      expect(readFileSync(file)).toEqual(bytes);
    } finally {
      await discarded.release();
      await discarded.release();
    }
  });

  it('does not manufacture bytes for a segment that never existed', async () => {
    const file = path.join(dir, 'missing.webm');
    const discarded = new VideoDiscard(dir);
    try {
      await discarded.discard(file);
      await discarded.restore();
      expect(existsSync(file)).toBe(false);
    } finally {
      await discarded.release();
    }
  });
});

// A trace publication can exhaust the remaining disk space after video deletion.
describe('VideoDiscard: full-disk recovery', () => {
  it.each([false, true])('keeps the complete original inode without a full or partial byte copy; partial=%s', async (partial) => {
    const file = path.join(dir, 'video.webm');
    const bytes = Buffer.from('the complete recording, including the final frames');
    writeFileSync(file, bytes);
    const inode = statSync(file).ino;
    const discarded = new VideoDiscard(dir);
    await discarded.discard(file);
    const copy = vi.spyOn(fs, 'createWriteStream').mockImplementation(() => new Writable({
      write(chunk, _encoding, callback) {
        writeFileSync(file, partial ? chunk.subarray(0, 3) : Buffer.alloc(0));
        callback(Object.assign(new Error('disk full during recovery'), { code: 'ENOSPC' }));
      },
    }) as ReturnType<typeof fs.createWriteStream>);
    syncBuiltinESMExports();
    try {
      await discarded.restore().catch(() => undefined);
      await discarded.restore();
      await discarded.release();
      expect(readFileSync(file)).toEqual(bytes);
      expect(statSync(file).ino).toBe(inode);
      expect(statSync(file).nlink).toBe(1);
      expect(copy).not.toHaveBeenCalled();
    } finally {
      copy.mockRestore();
      syncBuiltinESMExports();
      await discarded.release();
    }
  });
});


/** Only tests enumerate the transaction's private recovery paths. */
function recoveryPaths(): string[] {
  return readdirSync(dir).filter((name) => name.startsWith('.video-recovery-')).map((name) => path.join(dir, name, 'segment'));
}

describe('VideoDiscard: transactions', () => {
  it('stages multiple segments privately, consumes links before registration, and permits repeated discard/restore/release', async () => {
    const files = ['first.webm', 'second.webm'].map((name) => path.join(dir, name));
    for (const file of files) writeFileSync(file, file);
    const identities = files.map((file) => statSync(file).ino);
    const discarded = new VideoDiscard(dir);
    await Promise.all(files.flatMap((file) => [discarded.discard(file), discarded.discard(file)]));
    expect(files.map(existsSync)).toEqual([false, false]);
    for (const recovery of recoveryPaths()) {
      expect(statSync(path.dirname(recovery)).mode & 0o777).toBe(0o700);
      expect(statSync(recovery).nlink).toBe(1);
    }
    await discarded.restore();
    for (let index = 0; index < files.length; index++) {
      const file = files[index]!;
      expect(readFileSync(file, 'utf8')).toBe(file);
      expect(statSync(file).ino).toBe(identities[index]);
      expect(statSync(file).nlink).toBe(1);
      await discarded.discard(file);
    }
    await discarded.restore();
    await discarded.restore();
    await discarded.release();
    await discarded.release();
    expect(recoveryPaths()).toEqual([]);
  });

  it('leaves originals intact when staging itself runs out of space', async () => {
    const file = path.join(dir, 'video.webm');
    writeFileSync(file, 'complete');
    const staging = vi.spyOn(promises, 'link').mockRejectedValue(Object.assign(new Error('full'), { code: 'ENOSPC' }));
    syncBuiltinESMExports();
    const discarded = new VideoDiscard(dir);
    try {
      await expect(discarded.discard(file)).rejects.toMatchObject({ code: 'ENOSPC' });
      await expect(discarded.discard(file)).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(recoveryPaths()).toHaveLength(1);
      expect(existsSync(recoveryPaths()[0]!)).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe('complete');
      expect(statSync(file).nlink).toBe(1);
      await discarded.release();
      expect(recoveryPaths()).toEqual([]);
    } finally {
      staging.mockRestore();
      syncBuiltinESMExports();
      await discarded.release();
    }
  });

  it.each(['truncated', 'directory', 'symlink'] as const)('never accepts or overwrites a conflicting %s destination; failed recovery survives release', async (kind) => {
    const file = path.join(dir, 'video.webm');
    writeFileSync(file, 'complete original');
    const inode = statSync(file).ino;
    const discarded = new VideoDiscard(dir);
    await discarded.discard(file);
    if (kind === 'truncated') writeFileSync(file, 'part');
    if (kind === 'directory') mkdirSync(file);
    if (kind === 'symlink') {
      writeFileSync(path.join(dir, 'unrelated'), 'other data');
      symlinkSync(path.join(dir, 'unrelated'), file);
    }
    await expect(discarded.restore()).rejects.toThrow('video recovery failed');
    await expect(discarded.restore()).rejects.toThrow('video recovery failed');
    await discarded.release();
    await discarded.release();
    const backups = recoveryPaths();
    expect(backups).toHaveLength(1);
    expect(readFileSync(backups[0]!, 'utf8')).toBe('complete original');
    if (kind === 'truncated') expect(readFileSync(file, 'utf8')).toBe('part');
    if (kind === 'symlink') expect(readFileSync(file, 'utf8')).toBe('other data');
    rmSync(file, { recursive: true });
    await discarded.restore();
    expect(statSync(file).ino).toBe(inode);
    expect(statSync(file).nlink).toBe(1);
    await discarded.release();
    expect(recoveryPaths()).toEqual([]);
  });

  it('restores other segments even if one no-clobber link fails, and never releases the only complete copy', async () => {
    const first = path.join(dir, 'first.webm');
    const second = path.join(dir, 'second.webm');
    writeFileSync(first, 'first complete');
    writeFileSync(second, 'second complete');
    const discarded = new VideoDiscard(dir);
    await discarded.discard(first);
    await discarded.discard(second);
    const link = promises.link;
    const restoration = vi.spyOn(promises, 'link').mockImplementation(async (source, destination) => {
      if (destination === first) throw Object.assign(new Error('full'), { code: 'ENOSPC' });
      await link(source, destination);
    });
    syncBuiltinESMExports();
    try {
      await expect(discarded.restore()).rejects.toThrow('video recovery failed');
      await discarded.release();
      expect(existsSync(first)).toBe(false);
      expect(readFileSync(second, 'utf8')).toBe('second complete');
      expect(statSync(second).nlink).toBe(1);
      const backups = recoveryPaths();
      expect(backups).toHaveLength(1);
      expect(readFileSync(backups[0]!, 'utf8')).toBe('first complete');
    } finally {
      restoration.mockRestore();
      syncBuiltinESMExports();
    }
    await discarded.restore();
    expect(readFileSync(first, 'utf8')).toBe('first complete');
    expect(statSync(first).nlink).toBe(1);
    await discarded.release();
    expect(recoveryPaths()).toEqual([]);
  });

  it('does not claim single-link recovery until the duplicate link is removed after failed unlink', async () => {
    const file = path.join(dir, 'video.webm');
    writeFileSync(file, 'complete');
    const discarded = new VideoDiscard(dir);
    const remove = promises.rm;
    const blocked = vi.spyOn(promises, 'rm').mockRejectedValue(new Error('permission denied'));
    syncBuiltinESMExports();
    try {
      await expect(discarded.discard(file)).rejects.toThrow('permission denied');
      expect(existsSync(file)).toBe(false);
      const backup = recoveryPaths()[0]!;
      const inode = statSync(backup).ino;
      expect(statSync(backup).nlink).toBe(2);
      expect(readFileSync(backup, 'utf8')).toBe('complete');
      await expect(discarded.restore()).rejects.toThrow('video recovery failed');
      await discarded.release();
      expect(statSync(file).nlink).toBe(3);
      expect(statSync(file).ino).toBe(inode);
      expect(statSync(backup).nlink).toBe(3);
      expect(readFileSync(file, 'utf8')).toBe('complete');
      expect(recoveryPaths()).toHaveLength(1);
      blocked.mockImplementation(remove);
      await discarded.restore();
      expect(statSync(file).nlink).toBe(1);
    } finally {
      blocked.mockRestore();
      syncBuiltinESMExports();
      await discarded.release();
    }
  });

  it('keeps failed post-publication cleanup private and best-effort without failing or losing recovery', async () => {
    const file = path.join(dir, 'video.webm');
    writeFileSync(file, 'complete');
    const discarded = new VideoDiscard(dir);
    await discarded.discard(file);
    const blocked = vi.spyOn(promises, 'rm').mockRejectedValue(new Error('permission denied'));
    syncBuiltinESMExports();
    try {
      await discarded.release();
      expect(existsSync(file)).toBe(false);
      expect(readFileSync(recoveryPaths()[0]!, 'utf8')).toBe('complete');
    } finally {
      blocked.mockRestore();
      syncBuiltinESMExports();
    }
    await discarded.restore();
    expect(statSync(file).nlink).toBe(1);
    await discarded.release();
    expect(recoveryPaths()).toEqual([]);
  });

  it.each(['symlink', 'directory', 'hardlink', 'outside'] as const)('does not unlink an invalid %s segment', async (kind) => {
    const file = path.join(dir, 'video.webm');
    if (kind === 'directory') mkdirSync(file);
    else {
      writeFileSync(path.join(dir, 'other'), 'untouched');
      if (kind === 'hardlink') linkSync(path.join(dir, 'other'), file);
      else symlinkSync(path.join(dir, 'other'), file);
    }
    const discarded = new VideoDiscard(dir);
    await expect(discarded.discard(kind === 'outside' ? path.join(dir, '..', 'unowned.webm') : file)).rejects.toThrow();
    expect(existsSync(file)).toBe(true);
    await discarded.release();
    expect(recoveryPaths()).toEqual([]);
  });
});

/** Interposed OS faults model a recording producer atomically replacing its segment. */
describe('VideoDiscard: producer path handoffs', () => {
  it('preserves a producer file recreated after the claim at its public path through discard and release', async () => {
    const file = path.join(dir, 'video.webm');
    const original = Buffer.from('complete original recording');
    const replacement = Buffer.from('complete recreated recording');
    writeFileSync(file, original);
    const identity = statSync(file);
    const discarded = new VideoDiscard(dir);
    let replacementInode = 0;
    const rename = promises.rename;
    const moving = vi.spyOn(promises, 'rename').mockImplementation(async (source, destination) => {
      await rename(source, destination);
      if (source === file) {
        writeFileSync(file, replacement);
        replacementInode = statSync(file).ino;
      }
    });
    const deleting = vi.spyOn(promises, 'rm');
    syncBuiltinESMExports();
    try {
      await discarded.discard(file);
      expect(moving).toHaveBeenCalledTimes(1);
      expect(deleting).toHaveBeenCalledTimes(1);
      expect(readFileSync(file)).toEqual(replacement);
      expect(statSync(file).dev).toBe(identity.dev);
      expect(statSync(file).ino).toBe(replacementInode);
      expect(replacementInode).not.toBe(identity.ino);
      expect(statSync(file).nlink).toBe(1);
      const backups = recoveryPaths();
      expect(backups).toHaveLength(1);
      expect(readFileSync(backups[0]!)).toEqual(original);
      expect(statSync(backups[0]!).ino).toBe(identity.ino);
      expect(statSync(backups[0]!).nlink).toBe(1);
      await discarded.release();
      await discarded.release();
      expect(readFileSync(file)).toEqual(replacement);
      expect(statSync(file).dev).toBe(identity.dev);
      expect(statSync(file).ino).toBe(replacementInode);
      expect(statSync(file).nlink).toBe(1);
      expect(recoveryPaths()).toEqual([]);
      expect(readdirSync(dir)).toEqual(['video.webm']);
      expect(moving).toHaveBeenCalledTimes(1);
      expect(deleting).toHaveBeenCalledTimes(2);
      expect(deleting.mock.calls.every(([target]) => target !== file)).toBe(true);
    } finally {
      moving.mockRestore();
      deleting.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each([false, true])('preserves both inodes when a producer replaces the segment at discard handoff; staged=%s', async (staged) => {
    const file = path.join(dir, 'video.webm');
    const original = Buffer.from('complete original recording');
    const replacement = Buffer.from('complete next recording');
    writeFileSync(file, original);
    const inode = statSync(file).ino;
    const discarded = new VideoDiscard(dir);
    if (staged) {
      await discarded.discard(file);
      linkSync(recoveryPaths()[0]!, file);
    }
    let replacements = 0;
    let replacementInode = 0;
    const replace = (): void => {
      replacements++;
      const next = path.join(dir, 'producer-next');
      writeFileSync(next, replacement);
      replacementInode = statSync(next).ino;
      renameSync(next, file);
    };
    const rename = promises.rename;
    const remove = promises.rm;
    const moving = vi.spyOn(promises, 'rename').mockImplementation(async (source, destination) => {
      if (source === file) replace();
      await rename(source, destination);
    });
    const deleting = vi.spyOn(promises, 'rm').mockImplementation(async (target, options) => {
      if (target === file) replace();
      await remove(target, options);
    });
    syncBuiltinESMExports();
    try {
      await expect(discarded.discard(file)).rejects.toThrow('video segment changed during discard');
      expect(replacements).toBe(1);
      await discarded.restore();
      await discarded.release();
      expect(readFileSync(file)).toEqual(original);
      expect(statSync(file).ino).toBe(inode);
      expect(statSync(file).nlink).toBe(1);
      const remaining = readdirSync(dir, { recursive: true }).map((name) => path.join(dir, String(name))).filter((name) => statSync(name).isFile());
      expect(remaining).toHaveLength(2);
      const next = remaining.find((name) => statSync(name).ino === replacementInode)!;
      expect(readFileSync(next)).toEqual(replacement);
      expect(statSync(next).nlink).toBe(1);
    } finally {
      moving.mockRestore();
      deleting.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it.each([false, true])('does not clobber a producer destination created at restore handoff; repeated=%s', async (repeated) => {
    const file = path.join(dir, 'video.webm');
    writeFileSync(file, 'complete original');
    const inode = statSync(file).ino;
    const discarded = new VideoDiscard(dir);
    await discarded.discard(file);
    if (repeated) { await discarded.restore(); await discarded.discard(file); }
    let created = 0;
    let replacementInode = 0;
    const create = (): void => {
      created++;
      writeFileSync(file, 'complete racing producer');
      replacementInode = statSync(file).ino;
    };
    const rename = promises.rename;
    const link = promises.link;
    const moving = vi.spyOn(promises, 'rename').mockImplementation(async (source, destination) => {
      if (destination === file) create();
      await rename(source, destination);
    });
    const linking = vi.spyOn(promises, 'link').mockImplementation(async (source, destination) => {
      if (destination === file) create();
      await link(source, destination);
    });
    syncBuiltinESMExports();
    try {
      await expect(discarded.restore()).rejects.toThrow('video recovery failed');
      expect(created).toBe(1);
      await discarded.release();
      expect(readFileSync(file, 'utf8')).toBe('complete racing producer');
      expect(statSync(file).ino).toBe(replacementInode);
      expect(statSync(file).nlink).toBe(1);
      const backups = recoveryPaths();
      expect(backups).toHaveLength(1);
      expect(readFileSync(backups[0]!, 'utf8')).toBe('complete original');
      expect(statSync(backups[0]!).ino).toBe(inode);
      expect(statSync(backups[0]!).nlink).toBe(1);
    } finally {
      moving.mockRestore();
      linking.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

/** These syscalls deliberately complete after cancellation; cancellation is not atomic. */
describe('VideoDiscard: late path handoffs', () => {
  it.each(['claim', 'restore'] as const)('preserves late %s completion and fences queued destructive work', async (kind) => {
    const file = path.join(dir, 'video.webm');
    const bytes = Buffer.from('complete late recording');
    writeFileSync(file, bytes);
    const inode = statSync(file).ino;
    const discarded = new VideoDiscard(dir);
    if (kind === 'restore') await discarded.discard(file);
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const rename = promises.rename;
    const link = promises.link;
    const moving = vi.spyOn(promises, 'rename').mockImplementation(async (source, destination) => {
      if (kind === 'claim' && source === file) { enter(); await gate; }
      await rename(source, destination);
    });
    const linking = vi.spyOn(promises, 'link').mockImplementation(async (source, destination) => {
      if (kind === 'restore' && destination === file) { enter(); await gate; }
      await link(source, destination);
    });
    const deleting = vi.spyOn(promises, 'rm');
    syncBuiltinESMExports();
    const cancellation = new AbortController();
    const pending = kind === 'claim' ? discarded.discard(file, cancellation.signal) : discarded.restore(cancellation.signal);
    try {
      await entered;
      cancellation.abort();
      const queued = discarded.restore(cancellation.signal);
      const issued = { rename: moving.mock.calls.length, link: linking.mock.calls.length, rm: deleting.mock.calls.length };
      release();
      await expect(pending).rejects.toMatchObject({ code: 'CLEANUP_TIMEOUT' });
      await expect(queued).rejects.toMatchObject({ code: 'CLEANUP_TIMEOUT' });
      await discarded.release();
      expect(moving).toHaveBeenCalledTimes(issued.rename);
      expect(linking).toHaveBeenCalledTimes(issued.link);
      expect(deleting).toHaveBeenCalledTimes(issued.rm);
      const backup = recoveryPaths()[0]!;
      expect(readFileSync(backup)).toEqual(bytes);
      expect(statSync(backup).ino).toBe(inode);
      expect(statSync(backup).nlink).toBe(2);
      expect(existsSync(file)).toBe(kind === 'restore');
      if (kind === 'restore') {
        expect(readFileSync(file)).toEqual(bytes);
        expect(statSync(file).ino).toBe(inode);
      } else {
        const claimed = readdirSync(path.dirname(backup)).find((name) => name.startsWith('claim-'))!;
        const segment = path.join(path.dirname(backup), claimed, 'segment');
        expect(readFileSync(segment)).toEqual(bytes);
        expect(statSync(segment).ino).toBe(inode);
      }
    } finally {
      release();
      await pending.catch(() => undefined);
      moving.mockRestore(); linking.mockRestore(); deleting.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
