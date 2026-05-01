// Activity probe. Both the in-pod MCP server and the idle daemon
// agree on `mtime(/var/run/sandbox/activity)` as the single source of
// "the sandbox is doing something." Every successful tool call ends
// with `touch()`. The idle daemon reads mtime and SIGTERMs PID 1 when
// it's been still for longer than IDLE_TIMEOUT_SECONDS.

import { promises as fs } from "node:fs";
import { logger } from "./logger.js";

export class ActivityProbe {
  constructor(private readonly path: string) {}

  async touch(): Promise<void> {
    const now = new Date();
    try {
      await fs.utimes(this.path, now, now);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        // Recreate if a previous shutdown scrubbed it.
        try {
          await fs.writeFile(this.path, "");
        } catch (innerErr) {
          logger.warn(`activity: could not create probe file`, {
            path: this.path,
            error: (innerErr as Error).message,
          });
        }
        return;
      }
      logger.warn(`activity: could not touch probe file`, {
        path: this.path,
        error: e.message,
      });
    }
  }
}
