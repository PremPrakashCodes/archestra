// Thin wrapper around the tmux CLI. The in-pod MCP server runs as the
// same UID as the tmux server, so plain spawn() against the same socket
// file works without privilege juggling.

import { spawn } from "node:child_process";
import { logger } from "./logger.js";

export interface TmuxClientOptions {
  socket: string;
  session: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class TmuxClient {
  constructor(private readonly opts: TmuxClientOptions) {}

  // Run an arbitrary tmux subcommand against the socket. tmux's CLI
  // returns 0 on success and writes the result to stdout; we never feed
  // user-controlled strings as a single shell argument — every value is
  // passed as its own argv slot, so quoting bugs cannot turn into shell
  // injection.
  async run(args: string[], stdin?: Buffer | string): Promise<ExecResult> {
    return await runProcess("tmux", ["-S", this.opts.socket, ...args], stdin);
  }

  // Create a new tmux window in the persistent session and return its
  // window id (the leading `@` is stripped). Optional cwd is passed via
  // tmux's -c flag, optional name via -n.
  async newWindow(name?: string, cwd?: string): Promise<string> {
    const args = [
      "new-window",
      "-t",
      this.opts.session,
      "-P",
      "-F",
      "#{window_id}",
    ];
    if (name) {
      args.push("-n", name);
    }
    if (cwd) {
      args.push("-c", cwd);
    }
    const { stdout, stderr, exitCode } = await this.run(args);
    if (exitCode !== 0) {
      throw new TmuxError(
        `tmux new-window failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_NEW_WINDOW_FAILED",
      );
    }
    const id = stdout.trim().replace(/^@/, "");
    if (!id) {
      throw new TmuxError(
        `tmux new-window returned empty window id`,
        "TMUX_NEW_WINDOW_FAILED",
      );
    }
    return id;
  }

  // Send a literal string of text into a window. `-l` (literal) means
  // tmux does not interpret the bytes as keyboard shortcuts.
  async sendKeysLiteral(windowId: string, text: string): Promise<void> {
    if (!text) return;
    const target = `${this.opts.session}:@${windowId}`;
    const { stderr, exitCode } = await this.run([
      "send-keys",
      "-t",
      target,
      "-l",
      text,
    ]);
    if (exitCode !== 0) {
      throw new TmuxError(
        `tmux send-keys -l failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_SEND_KEYS_FAILED",
      );
    }
  }

  // Send a single named key (Enter, C-c, etc.) into a window.
  async sendKey(windowId: string, key: string): Promise<void> {
    const target = `${this.opts.session}:@${windowId}`;
    const { stderr, exitCode } = await this.run([
      "send-keys",
      "-t",
      target,
      key,
    ]);
    if (exitCode !== 0) {
      throw new TmuxError(
        `tmux send-keys ${key} failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_SEND_KEYS_FAILED",
      );
    }
  }

  // Capture the visible pane plus scrollback. -p prints to stdout, -e
  // preserves escape sequences, -J joins wrapped lines, -S -<n> grabs
  // n lines of history.
  async capturePane(windowId: string, scrollback = 5000): Promise<string> {
    const target = `${this.opts.session}:@${windowId}`;
    const { stdout, stderr, exitCode } = await this.run([
      "capture-pane",
      "-t",
      target,
      "-p",
      "-J",
      "-S",
      `-${scrollback}`,
    ]);
    if (exitCode !== 0) {
      // Closed window comes back as exit 1 with "can't find window".
      // Surface that as a typed error so the caller can map it.
      if (/can't find window|no current window|no such session/i.test(stderr)) {
        throw new TmuxError(
          `tmux capture-pane: window not found`,
          "TMUX_WINDOW_NOT_FOUND",
        );
      }
      throw new TmuxError(
        `tmux capture-pane failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_CAPTURE_FAILED",
      );
    }
    return stdout;
  }

  async listWindows(): Promise<TmuxWindowSummary[]> {
    const { stdout, stderr, exitCode } = await this.run([
      "list-windows",
      "-t",
      this.opts.session,
      "-F",
      "#{window_id}\t#{window_name}\t#{window_active}\t#{pane_current_path}",
    ]);
    if (exitCode !== 0) {
      throw new TmuxError(
        `tmux list-windows failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_LIST_FAILED",
      );
    }
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [rawId, name, active, cwd] = line.split("\t");
        return {
          windowId: (rawId ?? "").replace(/^@/, ""),
          name: name ?? "",
          active: active === "1",
          cwd: cwd ?? "",
        };
      });
  }

  async killWindow(windowId: string): Promise<void> {
    const target = `${this.opts.session}:@${windowId}`;
    const { stderr, exitCode } = await this.run([
      "kill-window",
      "-t",
      target,
    ]);
    if (exitCode !== 0) {
      if (/can't find window/i.test(stderr)) {
        throw new TmuxError(
          `tmux kill-window: window not found`,
          "TMUX_WINDOW_NOT_FOUND",
        );
      }
      throw new TmuxError(
        `tmux kill-window failed: ${stderr.trim() || `exit ${exitCode}`}`,
        "TMUX_KILL_FAILED",
      );
    }
  }
}

export interface TmuxWindowSummary {
  windowId: string;
  name: string;
  active: boolean;
  cwd: string;
}

export class TmuxError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "TmuxError";
  }
}

async function runProcess(
  cmd: string,
  args: string[],
  stdin?: Buffer | string,
): Promise<ExecResult> {
  return new Promise((resolveProcess, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      logger.error(`tmux spawn failed`, {
        cmd,
        args,
        error: err.message,
      });
      reject(err);
    });
    child.on("close", (code) => {
      resolveProcess({
        stdout,
        stderr,
        exitCode: typeof code === "number" ? code : 1,
      });
    });
    if (stdin !== undefined) {
      child.stdin.end(stdin);
    } else {
      child.stdin.end();
    }
  });
}
