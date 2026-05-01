import { EventEmitter } from "node:events";
import { vi } from "vitest";
import type { WebSocket } from "ws";
import { WebSocket as WS } from "ws";
import { sandboxFeature } from "@/features/sandbox/services/sandbox.feature";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import websocketService from "@/websocket";
import type { SandboxTerminalSocketContext } from "./sandbox.websocket";

type TtydWebSocketFactory = NonNullable<
  ConstructorParameters<typeof SandboxTerminalSocketContext>[0]["ttydFactory"]
>;

class FakeTtydWebSocket extends EventEmitter {
  readyState: number = WS.CONNECTING;
  sent: Array<string | Buffer> = [];
  closed = false;
  url: string;
  protocols: string | string[];

  constructor(url: string, protocols: string | string[]) {
    super();
    this.url = url;
    this.protocols = protocols;
  }

  send(payload: string | Buffer) {
    this.sent.push(payload);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS.CLOSED;
    queueMicrotask(() => this.emit("close"));
  }

  /** Test helper: simulate the upstream socket entering OPEN. */
  open() {
    this.readyState = WS.OPEN;
    this.emit("open");
  }

  /** Test helper: simulate ttyd emitting a binary command-byte frame. */
  pushOutput(data: string) {
    const buf = Buffer.alloc(data.length + 1);
    buf[0] = "0".charCodeAt(0);
    buf.write(data, 1, "utf-8");
    this.emit("message", buf);
  }

  pushRaw(buf: Buffer) {
    this.emit("message", buf);
  }
}

const service = websocketService as unknown as {
  handleMessage: (
    message: Parameters<SandboxTerminalSocketContext["handleMessage"]>[0],
    ws: WebSocket,
  ) => Promise<void>;
  clientContexts: Map<
    WebSocket,
    { userId: string; organizationId: string; userIsMcpServerAdmin: boolean }
  >;
  initSandboxTerminalContextForTesting: (overrides?: {
    ttydFactory?: TtydWebSocketFactory;
    authorizeConversation?: (params: {
      conversationId: string;
      userId: string;
      organizationId: string;
    }) => Promise<boolean>;
  }) => SandboxTerminalSocketContext;
  sandboxTerminalContext: SandboxTerminalSocketContext | null;
};

const CONVERSATION_ID = "11111111-1111-1111-1111-111111111111";

function makeFakeBrowserSocket(): {
  ws: WebSocket;
  send: ReturnType<typeof vi.fn>;
} {
  const send = vi.fn();
  const ws = {
    readyState: WS.OPEN,
    send,
    close: vi.fn(),
  } as unknown as WebSocket;
  return { ws, send };
}

function lastSentPayload(send: ReturnType<typeof vi.fn>) {
  const args = send.mock.calls.at(-1);
  if (!args) return null;
  return JSON.parse(args[0] as string);
}

function sentMessages(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls.map((c) => JSON.parse(c[0] as string));
}

describe("sandbox terminal websocket bridge", () => {
  let ttyd: FakeTtydWebSocket | null;
  let factory: TtydWebSocketFactory;
  type Authorizer = (params: {
    conversationId: string;
    userId: string;
    organizationId: string;
  }) => Promise<boolean>;
  let authorize: ReturnType<typeof vi.fn<Authorizer>>;

  beforeEach(() => {
    vi.restoreAllMocks();
    service.clientContexts.clear();

    ttyd = null;
    factory = vi.fn((url: string, protocols: string | string[]) => {
      ttyd = new FakeTtydWebSocket(url, protocols);
      return ttyd as unknown as WS;
    });
    authorize = vi.fn<Authorizer>().mockResolvedValue(true);

    service.initSandboxTerminalContextForTesting({
      ttydFactory: factory,
      authorizeConversation: authorize,
    });

    vi.spyOn(sandboxFeature, "isEnabled").mockReturnValue(true);
    vi.spyOn(sandboxFeature, "getState").mockResolvedValue({
      conversationId: CONVERSATION_ID,
      mcpServerId: "mcp-1",
      state: "running",
      mcpEndpointUrl: "http://sandbox-svc:8080/mcp",
      ttyEndpointUrl: "http://sandbox-svc:7681",
      podName: "pod-1",
      pvcName: "sandbox-pvc-1",
      secretName: "sandbox-secret-1",
      lastActivityAt: new Date(),
      idleDeadlineAt: new Date(Date.now() + 900_000),
      provisioningError: null,
    });
    vi.spyOn(sandboxFeature, "resolveTerminalConnection").mockResolvedValue({
      wsUrl: "ws://sandbox-svc:7681/ws",
      bearerToken: "secret-token",
    });
  });

  afterEach(() => {
    service.sandboxTerminalContext?.stop();
  });

  test("subscribe sends auth init then forwards ttyd output frames", async () => {
    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 100, rows: 32 },
      },
      ws,
    );

    expect(authorize).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
      userId: "u1",
      organizationId: "o1",
    });
    expect(factory).toHaveBeenCalledWith("ws://sandbox-svc:7681/ws", "tty");

    expect(ttyd).not.toBeNull();
    if (!ttyd) return;
    ttyd.open();

    // Auth init sent on open
    expect(ttyd.sent[0]).toEqual(
      JSON.stringify({
        AuthToken: "secret-token",
        columns: 100,
        rows: 32,
      }),
    );

    // ttyd emits an output frame -> bridge forwards string-decoded payload
    ttyd.pushOutput("hello world\n");

    const messages = sentMessages(send);
    expect(messages).toContainEqual({
      type: "sandbox_terminal_status",
      payload: { conversationId: CONVERSATION_ID, state: "connecting" },
    });
    expect(messages).toContainEqual({
      type: "sandbox_terminal_status",
      payload: { conversationId: CONVERSATION_ID, state: "connected" },
    });
    expect(messages).toContainEqual({
      type: "sandbox_terminal_output",
      payload: { conversationId: CONVERSATION_ID, data: "hello world\n" },
    });
  });

  test("non-output ttyd command bytes are ignored", async () => {
    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );

    if (!ttyd) throw new Error("ttyd not constructed");
    ttyd.open();

    // Command byte '1' = SET_WINDOW_TITLE — must be dropped
    const titleFrame = Buffer.alloc(6);
    titleFrame[0] = "1".charCodeAt(0);
    titleFrame.write("title", 1, "utf-8");
    ttyd.pushRaw(titleFrame);

    const outputs = sentMessages(send).filter(
      (m) => m.type === "sandbox_terminal_output",
    );
    expect(outputs).toHaveLength(0);
  });

  test("subscribe to a conversation the user does not own emits unauthorized", async () => {
    authorize.mockResolvedValueOnce(false);
    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );

    expect(factory).not.toHaveBeenCalled();
    expect(lastSentPayload(send)).toEqual({
      type: "sandbox_terminal_status",
      payload: { conversationId: CONVERSATION_ID, state: "unauthorized" },
    });
  });

  test("idle-suspended sandbox triggers resume before connecting", async () => {
    let suspendedOnce = false;
    vi.spyOn(sandboxFeature, "getState").mockImplementation(async () => {
      if (!suspendedOnce) {
        suspendedOnce = true;
        return {
          conversationId: CONVERSATION_ID,
          mcpServerId: "mcp-1",
          state: "idle-suspended",
          mcpEndpointUrl: null,
          ttyEndpointUrl: null,
          podName: null,
          pvcName: "sandbox-pvc-1",
          secretName: "sandbox-secret-1",
          lastActivityAt: new Date(),
          idleDeadlineAt: null,
          provisioningError: null,
        };
      }
      return {
        conversationId: CONVERSATION_ID,
        mcpServerId: "mcp-1",
        state: "running",
        mcpEndpointUrl: "http://sandbox-svc:8080/mcp",
        ttyEndpointUrl: "http://sandbox-svc:7681",
        podName: "pod-1",
        pvcName: "sandbox-pvc-1",
        secretName: "sandbox-secret-1",
        lastActivityAt: new Date(),
        idleDeadlineAt: new Date(Date.now() + 900_000),
        provisioningError: null,
      };
    });
    const resumeSpy = vi
      .spyOn(sandboxFeature, "resumeIfSuspended")
      .mockResolvedValue({
        conversationId: CONVERSATION_ID,
        mcpServerId: "mcp-1",
        state: "running",
        podName: "pod-1",
        pvcName: "sandbox-pvc-1",
        secretName: "sandbox-secret-1",
        lastActivityAt: new Date(),
        idleDeadlineAt: new Date(Date.now() + 900_000),
        provisioningError: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );

    expect(resumeSpy).toHaveBeenCalledWith({ conversationId: CONVERSATION_ID });
    expect(factory).toHaveBeenCalled();

    const messages = sentMessages(send);
    const states = messages.map((m) => m.payload?.state).filter(Boolean);
    expect(states).toContain("provisioning");
    expect(states).toContain("connecting");
  });

  test("resize forwards a command-byte-prefixed JSON frame to ttyd", async () => {
    const { ws } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );
    if (!ttyd) throw new Error("ttyd not constructed");
    ttyd.open();
    const sentBefore = ttyd.sent.length;

    await service.handleMessage(
      {
        type: "sandbox_terminal_resize",
        payload: { conversationId: CONVERSATION_ID, cols: 132, rows: 40 },
      },
      ws,
    );

    expect(ttyd.sent.length).toBe(sentBefore + 1);
    const resizeFrame = ttyd.sent[sentBefore];
    expect(Buffer.isBuffer(resizeFrame)).toBe(true);
    if (!Buffer.isBuffer(resizeFrame)) return;
    expect(resizeFrame[0]).toBe("1".charCodeAt(0));
    expect(resizeFrame.subarray(1).toString("utf-8")).toBe(
      JSON.stringify({ columns: 132, rows: 40 }),
    );
  });

  test("ttyd close transitions the panel to disconnected", async () => {
    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );
    if (!ttyd) throw new Error("ttyd not constructed");
    ttyd.open();
    send.mockClear();
    ttyd.close();

    await new Promise<void>((resolve) => {
      queueMicrotask(() => resolve());
    });

    expect(lastSentPayload(send)).toEqual({
      type: "sandbox_terminal_status",
      payload: { conversationId: CONVERSATION_ID, state: "disconnected" },
    });
  });

  test("subscribe when sandbox feature disabled emits an error status", async () => {
    vi.spyOn(sandboxFeature, "isEnabled").mockReturnValue(false);
    const { ws, send } = makeFakeBrowserSocket();
    service.clientContexts.set(ws, {
      userId: "u1",
      organizationId: "o1",
      userIsMcpServerAdmin: false,
    });

    await service.handleMessage(
      {
        type: "subscribe_sandbox_terminal",
        payload: { conversationId: CONVERSATION_ID, cols: 80, rows: 24 },
      },
      ws,
    );

    expect(factory).not.toHaveBeenCalled();
    expect(lastSentPayload(send)).toEqual({
      type: "sandbox_terminal_status",
      payload: {
        conversationId: CONVERSATION_ID,
        state: "error",
        error: "Sandbox feature is disabled",
      },
    });
  });
});
