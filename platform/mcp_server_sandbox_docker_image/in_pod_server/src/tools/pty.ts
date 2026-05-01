// pty_* tools — agent-facing PTY surface, brokered through tmux.
//
// The agent's intent maps to tmux operations:
//   pty_spawn  → `tmux new-window`            (returns sessionId == windowId)
//   pty_write  → `tmux send-keys -l` + Enter  (with command-broker filter)
//   pty_read   → `tmux capture-pane`          (sliced by lastReadOffset)
//   pty_list   → `tmux list-windows`
//   pty_kill   → `tmux kill-window`
//
// Defense in depth against the single-UID-pod risk: pty_write rejects
// payloads that contain literal substrings able to break the panel
// (tmux kill-server / kill-session, pkill tmux).

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TmuxClient, TmuxError } from "../tmux-client.js";
import { ActivityProbe } from "../activity.js";
import { logger } from "../logger.js";

const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /tmux\s+kill-server/i,
  /tmux\s+kill-session/i,
  /pkill\s+tmux/i,
  /kill\s+-9\s+\$\(\s*pgrep\s+tmux\s*\)/i,
];

const DEFAULT_MAX_SESSIONS = 16;

interface SessionRecord {
  windowId: string;
  // Number of UTF-16 code units already returned to the agent. The next
  // pty_read returns the slice from this offset onwards.
  lastReadOffset: number;
}

export interface PtyToolDeps {
  tmux: TmuxClient;
  activity: ActivityProbe;
  workspace: string;
  maxSessions?: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly maxSessions: number;

  constructor(private readonly deps: PtyToolDeps) {
    this.maxSessions = deps.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  async spawn(args: { name?: string; cwd?: string }): Promise<{
    sessionId: string;
  }> {
    if (this.sessions.size >= this.maxSessions) {
      throw new ToolError(
        "PTY_LIMIT",
        `maximum ${this.maxSessions} concurrent PTY sessions reached`,
      );
    }
    const cwd = args.cwd ?? this.deps.workspace;
    const windowId = await this.deps.tmux.newWindow(args.name, cwd);
    const sessionId = windowId;
    this.sessions.set(sessionId, { windowId, lastReadOffset: 0 });
    await this.deps.activity.touch();
    return { sessionId };
  }

  async write(args: {
    sessionId: string;
    text: string;
    sendEnter?: boolean;
  }): Promise<{ ok: true }> {
    const record = this.sessions.get(args.sessionId);
    if (!record) {
      throw new ToolError(
        "SESSION_NOT_FOUND",
        `pty session ${args.sessionId} not found`,
      );
    }
    rejectIfForbidden(args.text);
    try {
      await this.deps.tmux.sendKeysLiteral(record.windowId, args.text);
      if (args.sendEnter !== false && !args.text.endsWith("\n")) {
        await this.deps.tmux.sendKey(record.windowId, "Enter");
      } else if (args.text.endsWith("\n")) {
        // Trailing newline in the text already lands as a literal `\n`;
        // tmux requires an explicit Enter keystroke to fire the line.
        await this.deps.tmux.sendKey(record.windowId, "Enter");
      }
    } catch (err) {
      throw mapTmuxError(err, args.sessionId);
    }
    await this.deps.activity.touch();
    return { ok: true };
  }

  async read(args: {
    sessionId: string;
    scrollback?: number;
  }): Promise<{ data: string; offset: number }> {
    const record = this.sessions.get(args.sessionId);
    if (!record) {
      throw new ToolError(
        "SESSION_NOT_FOUND",
        `pty session ${args.sessionId} not found`,
      );
    }
    let captured: string;
    try {
      captured = await this.deps.tmux.capturePane(
        record.windowId,
        args.scrollback ?? 2000,
      );
    } catch (err) {
      throw mapTmuxError(err, args.sessionId);
    }
    const slice = captured.slice(record.lastReadOffset);
    record.lastReadOffset = captured.length;
    await this.deps.activity.touch();
    return { data: slice, offset: record.lastReadOffset };
  }

  async list(): Promise<{
    sessions: Array<{
      sessionId: string;
      name: string;
      active: boolean;
      cwd: string;
    }>;
  }> {
    const live = await this.deps.tmux.listWindows();
    const liveById = new Map(live.map((w) => [w.windowId, w]));
    // Drop registry entries whose window has been closed externally.
    for (const sessionId of [...this.sessions.keys()]) {
      const record = this.sessions.get(sessionId);
      if (record && !liveById.has(record.windowId)) {
        this.sessions.delete(sessionId);
      }
    }
    await this.deps.activity.touch();
    return {
      sessions: live.map((w) => ({
        sessionId: w.windowId,
        name: w.name,
        active: w.active,
        cwd: w.cwd,
      })),
    };
  }

  async kill(args: { sessionId: string }): Promise<{ ok: true }> {
    const record = this.sessions.get(args.sessionId);
    if (!record) {
      throw new ToolError(
        "SESSION_NOT_FOUND",
        `pty session ${args.sessionId} not found`,
      );
    }
    try {
      await this.deps.tmux.killWindow(record.windowId);
    } catch (err) {
      if (err instanceof TmuxError && err.code === "TMUX_WINDOW_NOT_FOUND") {
        // Idempotent: if it's already gone, drop the registry entry and succeed.
        this.sessions.delete(args.sessionId);
        await this.deps.activity.touch();
        return { ok: true };
      }
      throw mapTmuxError(err, args.sessionId);
    }
    this.sessions.delete(args.sessionId);
    await this.deps.activity.touch();
    return { ok: true };
  }
}

export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export function registerPtyTools(server: McpServer, manager: PtyManager): void {
  server.registerTool(
    "pty_spawn",
    {
      description:
        "Spawn a new PTY session (a tmux window) inside the sandbox. Returns a sessionId used by pty_write / pty_read / pty_kill.",
      inputSchema: {
        name: z
          .string()
          .max(64)
          .optional()
          .describe("Optional human-readable name for the tmux window."),
        cwd: z
          .string()
          .optional()
          .describe(
            "Optional working directory for the new shell. Defaults to /workspace.",
          ),
      },
    },
    async (args) => toolJson(await manager.spawn(args ?? {})),
  );

  server.registerTool(
    "pty_write",
    {
      description:
        "Write text into a PTY session. The text is sent literally (no shell interpretation) and Enter is appended to fire the line.",
      inputSchema: {
        sessionId: z.string().min(1),
        text: z.string(),
        sendEnter: z
          .boolean()
          .optional()
          .describe(
            "If false, do not append Enter after the text. Defaults to true.",
          ),
      },
    },
    async (args) => toolJson(await manager.write(args)),
  );

  server.registerTool(
    "pty_read",
    {
      description:
        "Read incremental output from a PTY session since the last read. Returns the new bytes plus the updated offset.",
      inputSchema: {
        sessionId: z.string().min(1),
        scrollback: z
          .number()
          .int()
          .positive()
          .max(20_000)
          .optional()
          .describe("Lines of scrollback to capture. Defaults to 2000."),
      },
    },
    async (args) => toolJson(await manager.read(args)),
  );

  server.registerTool(
    "pty_list",
    {
      description: "List all active PTY sessions.",
      inputSchema: {},
    },
    async () => toolJson(await manager.list()),
  );

  server.registerTool(
    "pty_kill",
    {
      description: "Terminate a PTY session. Idempotent.",
      inputSchema: {
        sessionId: z.string().min(1),
      },
    },
    async (args) => toolJson(await manager.kill(args)),
  );
}

function rejectIfForbidden(text: string): void {
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(text)) {
      logger.warn("pty_write: blocked forbidden command", {
        pattern: pattern.source,
      });
      throw new ToolError(
        "FORBIDDEN_COMMAND",
        `pty_write blocked: input matches the sandbox's tmux-protection deny-list (pattern: ${pattern.source})`,
      );
    }
  }
}

function mapTmuxError(err: unknown, sessionId: string): ToolError {
  if (err instanceof TmuxError && err.code === "TMUX_WINDOW_NOT_FOUND") {
    return new ToolError(
      "SESSION_NOT_FOUND",
      `pty session ${sessionId} no longer exists in tmux`,
    );
  }
  if (err instanceof Error) {
    return new ToolError("TMUX_ERROR", err.message);
  }
  return new ToolError("TMUX_ERROR", String(err));
}

export function toolJson(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value),
      },
    ],
  };
}
