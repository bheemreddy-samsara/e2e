/** Recoverable local video deletion while a hosted trace is awaiting publication. */

import { type Stats } from 'node:fs';
import { link, lstat, mkdtemp, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { InfrastructureError } from '../internal/errors.ts';

interface SavedVideo {
  readonly directory: string;
  readonly recovery: string;
  readonly identity: Stats;
  staged: boolean;
  readonly claims: Map<string, string>;
}

/**
 * Keeps the original inode in a private, unregistered same-filesystem link
 * before claiming a segment in a private path. Restore uses a no-clobber link,
 * never a byte copy that could run out of space and leave torn evidence.
 * Engines and output directories have the caller's trusted OS authority.
 */
export class VideoDiscard {
  private readonly files = new Map<string, SavedVideo>();
  private pending: Promise<void> = Promise.resolve();
  private retaining = false;
  private abandoned = false;

  constructor(private readonly root: string) {}

  /** Stages the complete inode before deleting its public artifact path. */
  discard(filePath: string, signal?: AbortSignal): Promise<void> {
    return this.run(async () => {
      const relative = path.relative(this.root, filePath);
      if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        throw new Error('video segment is outside its attempt directory');
      }
      let saved = this.files.get(filePath);
      if (saved?.staged) {
        if (!sameFile(await inspect(saved.recovery), saved.identity)) throw new Error('video recovery inode changed');
        const destination = await inspect(filePath);
        if (destination !== undefined && !sameFile(destination, saved.identity)) throw new Error('video segment changed during discard');
        await this.claimAndRemove(filePath, saved);
        return;
      }
      const identity = await inspect(filePath);
      if (identity === undefined) return;
      if (!identity.isFile() || identity.nlink !== 1) throw new Error('video segment must be a single-link regular file');
      if (saved !== undefined && !sameFile(identity, saved.identity)) throw new Error('video segment changed after recovery');
      this.check();
      const directory = saved?.directory ?? await mkdtemp(path.join(this.root, '.video-recovery-'));
      const recovery = path.join(directory, 'segment');
      saved = { directory, recovery, identity, staged: false, claims: saved?.claims ?? new Map() };
      this.files.set(filePath, saved);
      this.check();
      await link(filePath, recovery);
      saved.staged = true;
      this.check();
      if (!sameFile(await inspect(recovery), identity)) throw new Error('video recovery inode changed');
      await this.claimAndRemove(filePath, saved);
    }, signal);
  }

  /**
   * Restores each complete inode, dropping its extra link before registration.
   * A conflicting file is neither overwritten nor accepted as recovered.
   * Failed restoration keeps the recovery link even when release is called.
   */
  restore(signal?: AbortSignal): Promise<void> {
    // Claim retention before a pending discard can block the queue.
    this.retaining = true;
    return this.run(async () => {
      const failures: unknown[] = [];
      for (const [filePath, saved] of this.files) {
        try {
          this.check();
          const destination = await inspect(filePath);
          if (destination !== undefined && !sameFile(destination, saved.identity)) {
            throw new Error('video recovery destination is not the original segment');
          }
          if (saved.staged) {
            if (!sameFile(await inspect(saved.recovery), saved.identity)) throw new Error('video recovery inode changed');
            this.check();
            // link refuses EEXIST even if a producer creates the destination after inspection.
            if (destination === undefined) await link(saved.recovery, filePath);
            this.check();
            await this.removeClaims(saved);
            this.check();
            await rm(saved.recovery);
            saved.staged = false;
          } else if (destination === undefined) {
            throw new Error('restored video segment is missing');
          }
          this.check();
          const restored = await inspect(filePath);
          this.check();
          if (!sameFile(restored, saved.identity) || restored?.nlink !== 1) throw new Error('restored video segment is not single-link');
        } catch (cause) { failures.push(cause); }
      }
      this.check();
      if (failures.length > 0) throw new AggregateError(failures, 'video recovery failed');
    }, signal);
  }

  /**
   * Commits discarded video deletion only if retention was never required.
   * Private recovery cleanup is best-effort maintenance, not an engine failure:
   * it must not retire a worker and resolve new secrets after trace publication.
   * Failed restore or cleanup leaves bounded private files, not open handles.
   */
  release(signal?: AbortSignal): Promise<void> {
    // An abandoned queue may never settle; leave all recovery inodes alone.
    if (this.abandoned) return Promise.resolve();
    return this.run(async () => {
      for (const [filePath, saved] of this.files) {
        this.check();
        if (saved.staged) {
          if (this.retaining) continue;
          try {
            await this.removeClaims(saved);
            this.check();
            await rm(saved.recovery);
          } catch { continue; }
          saved.staged = false;
        }
        this.check();
        await rmdir(saved.directory).catch(() => undefined);
        this.files.delete(filePath);
      }
    }, signal);
  }

  /** Atomically takes the producer's path out of its namespace before checking what may be deleted. */
  private async claimAndRemove(filePath: string, saved: SavedVideo): Promise<void> {
    this.check();
    const directory = await mkdtemp(path.join(saved.directory, 'claim-'));
    const claimed = path.join(directory, 'segment');
    // Track before issuance: a late rename may complete after abandonment.
    saved.claims.set(claimed, directory);
    this.check();
    try { await rename(filePath, claimed); }
    catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
    }
    this.check();
    const identity = await inspect(claimed);
    if (identity !== undefined && !sameFile(identity, saved.identity)) throw new Error('video segment changed during discard');
    await this.removeClaims(saved);
  }

  /** Removes only original-inode links in private claims; racing producer inodes stay complete. */
  private async removeClaims(saved: SavedVideo): Promise<void> {
    for (const [claimed, directory] of saved.claims) {
      this.check();
      const identity = await inspect(claimed);
      if (identity !== undefined && !sameFile(identity, saved.identity)) continue;
      this.check();
      await rm(claimed, { force: true });
      this.check();
      await rmdir(directory).catch(() => undefined);
      saved.claims.delete(claimed);
    }
  }

  /** Refuses new destructive work after a cleanup scope abandoned this transaction. */
  private check(): void {
    if (this.abandoned) throw new InfrastructureError('CLEANUP_TIMEOUT', 'video retention transaction was abandoned');
  }

  /** Serializes work; cancellation fences both active and queued continuations synchronously. */
  private run(operation: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    const abandon = (): void => { this.abandoned = true; };
    signal?.addEventListener('abort', abandon, { once: true });
    if (signal?.aborted) abandon();
    const result = this.pending.then(async () => {
      this.check();
      await operation();
      this.check();
    });
    this.pending = result.catch(() => undefined);
    return result.finally(() => signal?.removeEventListener('abort', abandon));
  }
}

/** Checks the path itself, never a symlink's target; a missing segment is harmless. */
async function inspect(filePath: string): Promise<Stats | undefined> {
  return lstat(filePath).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === 'ENOENT') return undefined;
    throw cause;
  });
}

/** Finalized recordings retain both inode identity and size through the transaction. */
function sameFile(actual: Stats | undefined, expected: Stats): boolean {
  return actual?.isFile() === true && actual.dev === expected.dev && actual.ino === expected.ino && actual.size === expected.size;
}
