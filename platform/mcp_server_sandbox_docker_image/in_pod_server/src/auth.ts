// Bearer-token auth backed by a Kubernetes Secret-mounted file.
//
// Kubelet propagates Secret changes to mounted files on its sync
// interval (default 60–90s, configurable via --sync-frequency). The
// file watcher here reloads on the next event after the file changes;
// rotation has propagation lag bounded by that interval.

import { promises as fs } from "node:fs";
import { logger } from "./logger.js";

const POLL_INTERVAL_MS = 2_000;

export class TokenStore {
  private current = "";
  private filePath: string;
  private lastMtimeMs: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    filePath: string,
    private readonly pollIntervalMs = POLL_INTERVAL_MS,
  ) {
    this.filePath = filePath;
  }

  async start(): Promise<void> {
    await this.reload();
    // mtime-polling is the right primitive here. Kubelet swaps the
    // backing file on Secret rotation via a symlink-rename to a new
    // inode every sync interval (~60–90s), and inotify on the
    // userspace side is fragile across that swap on some kernels. A
    // small periodic stat is cheap, cross-platform, and surfaces the
    // change reliably without depending on the watcher's fidelity.
    this.pollTimer = setInterval(() => {
      this.checkAndReload().catch((err) => {
        logger.error(
          `auth: bearer-token reload failed: ${(err as Error).message}`,
        );
      });
    }, this.pollIntervalMs);
    this.pollTimer.unref();
  }

  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // Force an immediate reload check; tests use this to deterministically
  // re-read after writing a new value, without waiting for the poll tick.
  async refresh(): Promise<void> {
    await this.checkAndReload();
  }

  private async checkAndReload(): Promise<void> {
    let stat;
    try {
      stat = await fs.stat(this.filePath);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "ENOENT") {
        logger.warn(`auth: stat ${this.filePath} failed`, {
          error: e.message,
        });
      }
      return;
    }
    if (this.lastMtimeMs !== null && stat.mtimeMs === this.lastMtimeMs) {
      return;
    }
    await this.reload();
  }

  // Constant-time compare against the current token. Empty current
  // means "not yet loaded"; any compare against the empty string also
  // returns false, so requests racing the first reload are rejected.
  verify(presented: string): boolean {
    if (!presented || !this.current) return false;
    return constantTimeEqual(presented, this.current);
  }

  private async reload(): Promise<void> {
    const [raw, stat] = await Promise.all([
      fs.readFile(this.filePath, "utf8"),
      fs.stat(this.filePath),
    ]);
    this.current = raw.trim();
    this.lastMtimeMs = stat.mtimeMs;
    if (!this.current) {
      logger.warn(`auth: bearer-token file ${this.filePath} is empty`);
    }
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export function extractBearer(headerValue: string | undefined): string | null {
  if (!headerValue) return null;
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() ?? null;
}
