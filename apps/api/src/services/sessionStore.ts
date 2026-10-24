import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

export interface RepositoryInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  htmlUrl: string;
  description: string | null;
  /** Whether GitHub reported the repository as private. Never includes credentials. */
  private: boolean;
}

export interface RepoSession {
  id: string;
  repository: RepositoryInfo;
  fileCount: number;
  createdAt: number;
  expiresAt: number;
  /** Absolute path to the extracted files. Server-side only; never sent to clients. */
  filesDir: string;
}

interface StoredSession extends RepoSession {
  rootDir: string;
  timer: NodeJS.Timeout;
}

/**
 * In-memory registry of connected repositories. Each session owns a directory under
 * `reposDir` and is deleted (files included) when it expires after `ttlMs`.
 */
export class SessionStore {
  private readonly sessions = new Map<string, StoredSession>();

  constructor(
    private readonly reposDir: string,
    private readonly ttlMs: number,
  ) {}

  add(session: Omit<RepoSession, "expiresAt"> & { rootDir: string }): RepoSession {
    const expiresAt = session.createdAt + this.ttlMs;
    const timer = setTimeout(() => {
      void this.delete(session.id);
    }, this.ttlMs);
    // Do not keep the process alive just for the expiry timer.
    timer.unref?.();

    const stored: StoredSession = { ...session, expiresAt, timer };
    this.sessions.set(session.id, stored);
    return this.toPublic(stored);
  }

  get(id: string): RepoSession | undefined {
    const stored = this.sessions.get(id);
    return stored ? this.toPublic(stored) : undefined;
  }

  /** Delete a session and remove its directory from disk. Safe to call repeatedly. */
  async delete(id: string): Promise<boolean> {
    const stored = this.sessions.get(id);
    if (!stored) return false;
    clearTimeout(stored.timer);
    this.sessions.delete(id);
    await rm(stored.rootDir, { recursive: true, force: true });
    return true;
  }

  /**
   * Remove any directories under `reposDir` that are not tracked in memory. Run on
   * startup so clones abandoned by a previous (crashed/restarted) process are cleaned up.
   */
  async sweepOrphans(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.reposDir);
    } catch {
      return 0; // Directory does not exist yet; nothing to sweep.
    }

    let removed = 0;
    for (const entry of entries) {
      if (this.sessions.has(entry)) continue;
      await rm(join(this.reposDir, entry), { recursive: true, force: true });
      removed += 1;
    }
    return removed;
  }

  /** Clear all expiry timers (used in tests to let the process exit cleanly). */
  shutdown(): void {
    for (const stored of this.sessions.values()) {
      clearTimeout(stored.timer);
    }
    this.sessions.clear();
  }

  private toPublic(stored: StoredSession): RepoSession {
    const { rootDir: _rootDir, timer: _timer, ...publicFields } = stored;
    return publicFields;
  }
}
