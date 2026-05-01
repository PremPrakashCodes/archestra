import type { ServerWebSocketMessage } from "@shared";
import type { WebSocket, WebSocketServer } from "ws";
import { WebSocket as WS } from "ws";
import { sandboxFeature } from "@/features/sandbox/services/sandbox.feature";
import { SandboxRuntimeError } from "@/features/sandbox/services/sandbox-state.types";
import logger from "@/logging";
import { ConversationModel } from "@/models";

/**
 * ttyd's binary WS protocol uses a single ASCII command byte as the first byte
 * of every frame. We forward only OUTPUT frames to the panel; status frames
 * (window title, preferences) are intentionally dropped.
 */
const TTYD_CMD_OUTPUT = "0".charCodeAt(0); // 0x30
const TTYD_CMD_RESIZE = "1".charCodeAt(0); // 0x31

const TTYD_SUBPROTOCOL = "tty";

/** Maximum time to wait for the per-conversation ttyd WS to open before giving up. */
const TTYD_CONNECT_TIMEOUT_MS = 10_000;

const SANDBOX_TERMINAL_MESSAGE_TYPES = new Set([
  "subscribe_sandbox_terminal",
  "unsubscribe_sandbox_terminal",
  "sandbox_terminal_resize",
]);

/**
 * Pluggable WebSocket constructor so tests can inject a fake outbound socket
 * without actually dialling ttyd.
 */
type TtydWebSocketFactory = (url: string, protocols: string | string[]) => WS;

const defaultFactory: TtydWebSocketFactory = (url, protocols) =>
  new WS(url, protocols);

interface SandboxTerminalSubscription {
  conversationId: string;
  ttydWs: WS;
  cols: number;
  rows: number;
}

type SandboxTerminalContextParams = {
  wss: WebSocketServer | null;
  sendToClient: (ws: WebSocket, message: ServerWebSocketMessage) => void;
  ttydFactory?: TtydWebSocketFactory;
  /** Override for tests that don't run a real WebSocketService. */
  authorizeConversation?: (params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }) => Promise<boolean>;
};

/**
 * Per-WebSocket-server state for sandbox terminal subscriptions. Mirrors the
 * shape of `BrowserStreamSocketClientContext`: the global `WebSocketService`
 * holds a single instance, and per-WS subscriptions are tracked here.
 */
export class SandboxTerminalSocketContext {
  private wss: WebSocketServer | null;
  private subscriptions = new Map<WebSocket, SandboxTerminalSubscription>();
  private sendToClient: SandboxTerminalContextParams["sendToClient"];
  private ttydFactory: TtydWebSocketFactory;
  private authorizeConversation: SandboxTerminalContextParams["authorizeConversation"];

  constructor(params: SandboxTerminalContextParams) {
    this.wss = params.wss;
    this.sendToClient = params.sendToClient;
    this.ttydFactory = params.ttydFactory ?? defaultFactory;
    this.authorizeConversation = params.authorizeConversation;
  }

  setServer(wss: WebSocketServer | null) {
    this.wss = wss;
  }

  static isSandboxTerminalMessage(messageType: string): boolean {
    return SANDBOX_TERMINAL_MESSAGE_TYPES.has(messageType);
  }

  isSandboxTerminalMessage(messageType: string): boolean {
    return SandboxTerminalSocketContext.isSandboxTerminalMessage(messageType);
  }

  hasSubscription(ws: WebSocket): boolean {
    return this.subscriptions.has(ws);
  }

  getSubscription(ws: WebSocket): SandboxTerminalSubscription | undefined {
    return this.subscriptions.get(ws);
  }

  clearSubscriptions(): void {
    for (const ws of [...this.subscriptions.keys()]) {
      this.unsubscribe(ws);
    }
  }

  stop(): void {
    this.clearSubscriptions();
  }

  /**
   * Dispatch a sandbox terminal message. Returns true when the message was
   * handled (or rejected with an authoritative status), false when the type
   * is not owned by this context.
   */
  async handleMessage(
    message: { type: string; payload?: unknown },
    ws: WebSocket,
    clientContext: { userId: string; organizationId: string },
  ): Promise<boolean> {
    if (!this.isSandboxTerminalMessage(message.type)) {
      return false;
    }

    const payload = (message.payload ?? {}) as Record<string, unknown>;
    const conversationId =
      typeof payload.conversationId === "string" ? payload.conversationId : "";

    if (!conversationId) {
      // Defense in depth — discriminated union should already enforce this.
      logger.warn(
        { messageType: message.type },
        "Sandbox terminal message missing conversationId",
      );
      return true;
    }

    switch (message.type) {
      case "subscribe_sandbox_terminal": {
        const cols = typeof payload.cols === "number" ? payload.cols : 80;
        const rows = typeof payload.rows === "number" ? payload.rows : 24;
        await this.handleSubscribe(ws, {
          conversationId,
          cols,
          rows,
          userId: clientContext.userId,
          organizationId: clientContext.organizationId,
        });
        return true;
      }
      case "unsubscribe_sandbox_terminal":
        this.unsubscribe(ws);
        return true;
      case "sandbox_terminal_resize": {
        const cols = typeof payload.cols === "number" ? payload.cols : null;
        const rows = typeof payload.rows === "number" ? payload.rows : null;
        if (cols === null || rows === null) {
          return true;
        }
        this.handleResize(ws, conversationId, cols, rows);
        return true;
      }
      default:
        return false;
    }
  }

  private async handleSubscribe(
    ws: WebSocket,
    params: {
      conversationId: string;
      cols: number;
      rows: number;
      userId: string;
      organizationId: string;
    },
  ): Promise<void> {
    // Drop any prior subscription for this socket (single sandbox per WS).
    this.unsubscribe(ws);

    const { conversationId, cols, rows, userId, organizationId } = params;

    const authorized = await this.checkConversationOwnership({
      conversationId,
      userId,
      organizationId,
    });
    if (!authorized) {
      this.emitStatus(ws, conversationId, "unauthorized");
      return;
    }

    if (!sandboxFeature.isEnabled()) {
      this.emitStatus(
        ws,
        conversationId,
        "error",
        "Sandbox feature is disabled",
      );
      return;
    }

    let state = await sandboxFeature.getState({ conversationId });
    if (!state) {
      this.emitStatus(
        ws,
        conversationId,
        "error",
        "No sandbox provisioned for this conversation",
      );
      return;
    }

    if (state.state === "idle-suspended") {
      this.emitStatus(ws, conversationId, "provisioning");
      try {
        await sandboxFeature.resumeIfSuspended({ conversationId });
        state = await sandboxFeature.getState({ conversationId });
      } catch (error) {
        const message = errorMessage(error);
        logger.warn({ err: error, conversationId }, "Sandbox resume failed");
        this.emitStatus(ws, conversationId, "disconnected", message);
        return;
      }
    }

    if (!state || state.state !== "running") {
      this.emitStatus(
        ws,
        conversationId,
        state?.state === "error" ? "error" : "disconnected",
        state?.provisioningError ?? undefined,
      );
      return;
    }

    const connection = await sandboxFeature.resolveTerminalConnection({
      conversationId,
    });
    if (!connection) {
      this.emitStatus(
        ws,
        conversationId,
        "disconnected",
        "Sandbox terminal endpoint is not reachable",
      );
      return;
    }

    this.emitStatus(ws, conversationId, "connecting");

    let ttydWs: WS;
    try {
      ttydWs = this.ttydFactory(connection.wsUrl, TTYD_SUBPROTOCOL);
    } catch (error) {
      logger.error(
        { err: error, conversationId },
        "Failed to construct ttyd WebSocket",
      );
      this.emitStatus(ws, conversationId, "disconnected", errorMessage(error));
      return;
    }

    const connectTimer = setTimeout(() => {
      logger.warn({ conversationId }, "ttyd connection timed out");
      try {
        ttydWs.close();
      } catch {
        // best-effort
      }
    }, TTYD_CONNECT_TIMEOUT_MS);

    ttydWs.on("open", () => {
      clearTimeout(connectTimer);
      try {
        ttydWs.send(
          JSON.stringify({
            AuthToken: connection.bearerToken,
            columns: cols,
            rows,
          }),
        );
      } catch (error) {
        logger.error(
          { err: error, conversationId },
          "Failed to send ttyd auth init",
        );
        this.emitStatus(
          ws,
          conversationId,
          "disconnected",
          errorMessage(error),
        );
        try {
          ttydWs.close();
        } catch {
          // best-effort
        }
        return;
      }
      this.emitStatus(ws, conversationId, "connected");
    });

    ttydWs.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
      const buf = toBuffer(raw);
      if (buf.length === 0) return;
      const cmd = buf[0];
      if (cmd === TTYD_CMD_OUTPUT) {
        const data = buf.subarray(1).toString("utf-8");
        if (data.length === 0) return;
        this.sendToClient(ws, {
          type: "sandbox_terminal_output",
          payload: { conversationId, data },
        });
      }
      // Other command bytes (set window title, preferences) are ignored.
    });

    ttydWs.on("error", (error: unknown) => {
      logger.warn({ err: error, conversationId }, "ttyd WebSocket error");
      this.emitStatus(ws, conversationId, "disconnected", errorMessage(error));
    });

    ttydWs.on("close", () => {
      clearTimeout(connectTimer);
      const sub = this.subscriptions.get(ws);
      if (sub?.ttydWs === ttydWs) {
        this.subscriptions.delete(ws);
        this.emitStatus(ws, conversationId, "disconnected");
      }
    });

    this.subscriptions.set(ws, {
      conversationId,
      ttydWs,
      cols,
      rows,
    });
  }

  private handleResize(
    ws: WebSocket,
    conversationId: string,
    cols: number,
    rows: number,
  ): void {
    const sub = this.subscriptions.get(ws);
    if (!sub || sub.conversationId !== conversationId) return;
    if (sub.ttydWs.readyState !== WS.OPEN) return;

    const payload = JSON.stringify({ columns: cols, rows });
    const buffer = Buffer.alloc(payload.length + 1);
    buffer[0] = TTYD_CMD_RESIZE;
    buffer.write(payload, 1, "utf-8");
    try {
      sub.ttydWs.send(buffer);
      sub.cols = cols;
      sub.rows = rows;
    } catch (error) {
      logger.warn({ err: error, conversationId }, "ttyd resize send failed");
    }
  }

  unsubscribeForSocket(ws: WebSocket): void {
    this.unsubscribe(ws);
  }

  private unsubscribe(ws: WebSocket): void {
    const sub = this.subscriptions.get(ws);
    if (!sub) return;
    this.subscriptions.delete(ws);
    if (
      sub.ttydWs.readyState === WS.OPEN ||
      sub.ttydWs.readyState === WS.CONNECTING
    ) {
      try {
        sub.ttydWs.close();
      } catch {
        // best-effort
      }
    }
    logger.info(
      { conversationId: sub.conversationId },
      "Sandbox terminal client unsubscribed",
    );
  }

  private async checkConversationOwnership(params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }): Promise<boolean> {
    if (this.authorizeConversation) {
      return this.authorizeConversation(params);
    }
    const agentId = await ConversationModel.getAgentIdForUser(
      params.conversationId,
      params.userId,
      params.organizationId,
    );
    return agentId !== null;
  }

  private emitStatus(
    ws: WebSocket,
    conversationId: string,
    state: import("@shared").SandboxTerminalState,
    error?: string,
  ): void {
    this.sendToClient(ws, {
      type: "sandbox_terminal_status",
      payload: {
        conversationId,
        state,
        ...(error ? { error } : {}),
      },
    });
  }
}

function toBuffer(raw: Buffer | ArrayBuffer | Buffer[]): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw);
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function errorMessage(error: unknown): string {
  if (error instanceof SandboxRuntimeError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unknown error";
}
