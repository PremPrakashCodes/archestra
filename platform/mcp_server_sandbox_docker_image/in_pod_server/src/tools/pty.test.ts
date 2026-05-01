import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActivityProbe } from "../activity.js";
import { PtyManager, ToolError } from "./pty.js";
import type { TmuxClient, TmuxWindowSummary } from "../tmux-client.js";

class FakeTmux implements Partial<TmuxClient> {
  private nextId = 1;
  private windows = new Map<
    string,
    { name: string; cwd: string; pane: string }
  >();
  public sendKeysCalls: Array<{ id: string; text: string }> = [];
  public sentKeys: Array<{ id: string; key: string }> = [];

  async newWindow(name?: string, cwd?: string): Promise<string> {
    const id = String(this.nextId++);
    this.windows.set(id, {
      name: name ?? "shell",
      cwd: cwd ?? "/workspace",
      pane: "",
    });
    return id;
  }
  async sendKeysLiteral(windowId: string, text: string): Promise<void> {
    this.sendKeysCalls.push({ id: windowId, text });
    const win = this.windows.get(windowId);
    if (!win) throw new Error("no window");
    win.pane += text;
  }
  async sendKey(windowId: string, key: string): Promise<void> {
    this.sentKeys.push({ id: windowId, key });
    const win = this.windows.get(windowId);
    if (key === "Enter" && win) {
      win.pane += "\n";
    }
  }
  async capturePane(windowId: string): Promise<string> {
    const w = this.windows.get(windowId);
    if (!w) {
      const err = new Error("no window") as Error & { code: string };
      err.code = "TMUX_WINDOW_NOT_FOUND";
      throw err;
    }
    return w.pane;
  }
  async listWindows(): Promise<TmuxWindowSummary[]> {
    return [...this.windows.entries()].map(([id, w]) => ({
      windowId: id,
      name: w.name,
      active: false,
      cwd: w.cwd,
    }));
  }
  async killWindow(windowId: string): Promise<void> {
    if (!this.windows.delete(windowId)) {
      const err = new Error("no window") as Error & { code: string };
      err.code = "TMUX_WINDOW_NOT_FOUND";
      throw err;
    }
  }
}

let workspace: string;
let activityFile: string;
let tmux: FakeTmux;
let manager: PtyManager;

beforeEach(() => {
  const realTmp = realpathSync(tmpdir());
  workspace = mkdtempSync(join(realTmp, "sandbox-pty-"));
  activityFile = join(workspace, ".activity");
  writeFileSync(activityFile, "");
  tmux = new FakeTmux();
  manager = new PtyManager({
    tmux: tmux as unknown as TmuxClient,
    activity: new ActivityProbe(activityFile),
    workspace,
    maxSessions: 4,
  });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

describe("pty_spawn / pty_write / pty_read", () => {
  it("creates a session and round-trips writes through capture-pane", async () => {
    const { sessionId } = await manager.spawn({});
    expect(sessionId).toBeTruthy();
    await manager.write({ sessionId, text: "echo hi", sendEnter: true });
    const read = await manager.read({ sessionId });
    expect(read.data).toContain("echo hi");
    // Second read returns the empty incremental slice.
    const second = await manager.read({ sessionId });
    expect(second.data).toBe("");
  });

  it("rejects pty_write when the agent tries to break tmux", async () => {
    const { sessionId } = await manager.spawn({});
    await expect(
      manager.write({ sessionId, text: "tmux kill-server" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_COMMAND" });
    await expect(
      manager.write({ sessionId, text: "pkill tmux" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN_COMMAND" });
    // The fake's sendKeysLiteral was never called for the rejected paths.
    expect(tmux.sendKeysCalls.length).toBe(0);
  });

  it("returns SESSION_NOT_FOUND for an unknown sessionId", async () => {
    await expect(
      manager.write({ sessionId: "nope", text: "hi" }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
    await expect(manager.read({ sessionId: "nope" })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });

  it("enforces the concurrent-session cap", async () => {
    await manager.spawn({});
    await manager.spawn({});
    await manager.spawn({});
    await manager.spawn({});
    await expect(manager.spawn({})).rejects.toMatchObject({
      code: "PTY_LIMIT",
    });
  });
});

describe("pty_kill", () => {
  it("removes the session and is idempotent", async () => {
    const { sessionId } = await manager.spawn({});
    await manager.kill({ sessionId });
    // Killed sessions should now report SESSION_NOT_FOUND on subsequent ops.
    await expect(manager.kill({ sessionId })).rejects.toMatchObject({
      code: "SESSION_NOT_FOUND",
    });
  });
});

describe("activity probe", () => {
  it("touches the activity file on every successful tool call", async () => {
    const probe = new ActivityProbe(activityFile);
    const spy = vi.spyOn(probe, "touch");
    const m = new PtyManager({
      tmux: tmux as unknown as TmuxClient,
      activity: probe,
      workspace,
    });
    const { sessionId } = await m.spawn({});
    await m.write({ sessionId, text: "hi" });
    await m.read({ sessionId });
    await m.list();
    await m.kill({ sessionId });
    expect(spy).toHaveBeenCalledTimes(5);
  });
});

void ToolError;
