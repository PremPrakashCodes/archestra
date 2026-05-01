import type {
  SandboxTerminalOutputMessage,
  SandboxTerminalState,
  SandboxTerminalStatusMessage,
} from "@shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// jsdom does not implement ResizeObserver; the panel uses one to drive
// terminal resize messages. Stub before the component mounts.
class ResizeObserverStub {
  observe() {}
  disconnect() {}
  unobserve() {}
}
(globalThis as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
  ResizeObserverStub as unknown as typeof ResizeObserver;

const mockSend = vi.fn();
const mockConnect = vi.fn();
const subscriptions = new Map<string, ((message: unknown) => void)[]>();

vi.mock("@/lib/websocket/websocket", () => ({
  default: {
    connect: () => mockConnect(),
    send: (m: unknown) => mockSend(m),
    subscribe: (
      type: string,
      handler: (message: unknown) => void,
    ): (() => void) => {
      const list = subscriptions.get(type) ?? [];
      list.push(handler);
      subscriptions.set(type, list);
      return () => {
        const remaining = (subscriptions.get(type) ?? []).filter(
          (h) => h !== handler,
        );
        subscriptions.set(type, remaining);
      };
    },
  },
}));

const mockToastError = vi.fn();
const mockToastSuccess = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => mockToastError(...args),
    success: (...args: unknown[]) => mockToastSuccess(...args),
  },
}));

const mockUploadMutate = vi.fn();
vi.mock("@/lib/sandbox/sandbox.query", () => ({
  SANDBOX_FILE_UPLOAD_MAX_BYTES: 16 * 1024 * 1024,
  useSandboxFileUpload: () => ({
    mutate: (vars: unknown) => mockUploadMutate(vars),
    isPending: false,
  }),
}));

// xterm.js imports `xterm.css` and uses canvas APIs that strain jsdom; stub
// the modules so the panel can mount without exercising the real terminal.
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    loadAddon() {}
    open() {}
    write() {}
    dispose() {}
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return { cols: 80, rows: 24 };
    }
  },
}));

vi.mock("@xterm/xterm/css/xterm.css", () => ({}));

import { SandboxTerminalPanel } from "./sandbox-terminal-panel";

function wrap(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function emitStatus(state: SandboxTerminalState, error?: string) {
  const message: SandboxTerminalStatusMessage = {
    type: "sandbox_terminal_status",
    payload: { conversationId: "c1", state, error },
  };
  for (const handler of subscriptions.get("sandbox_terminal_status") ?? []) {
    handler(message);
  }
}

function emitOutput(data: string) {
  const message: SandboxTerminalOutputMessage = {
    type: "sandbox_terminal_output",
    payload: { conversationId: "c1", data },
  };
  for (const handler of subscriptions.get("sandbox_terminal_output") ?? []) {
    handler(message);
  }
}

describe("SandboxTerminalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    subscriptions.clear();
  });

  it("renders nothing when closed", () => {
    render(
      wrap(
        <SandboxTerminalPanel
          isOpen={false}
          onClose={() => {}}
          conversationId="c1"
        />,
      ),
    );
    expect(screen.queryByTestId("sandbox-terminal-panel")).toBeNull();
  });

  it("shows the idle copy when no conversation is selected", () => {
    render(
      wrap(
        <SandboxTerminalPanel
          isOpen
          onClose={() => {}}
          conversationId={undefined}
        />,
      ),
    );
    expect(screen.getByText(/no sandbox running yet/i)).toBeInTheDocument();
    expect(
      screen.getByText(/agent will provision a sandbox on first use/i),
    ).toBeInTheDocument();
  });

  it("subscribes when mounted with a conversation and unsubscribes on unmount", async () => {
    const { unmount } = render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    // Wait for the dynamic xterm import to resolve.
    await act(async () => {
      await Promise.resolve();
    });

    const subscribeCall = mockSend.mock.calls.find(
      (call) =>
        (call[0] as { type: string }).type === "subscribe_sandbox_terminal",
    );
    expect(subscribeCall).toBeDefined();
    expect(
      (subscribeCall?.[0] as { payload: { conversationId: string } }).payload
        .conversationId,
    ).toBe("c1");

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    const unsubCall = mockSend.mock.calls.find(
      (call) =>
        (call[0] as { type: string }).type === "unsubscribe_sandbox_terminal",
    );
    expect(unsubCall).toBeDefined();
  });

  it("shows the suspend copy on idle-suspended state", async () => {
    render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emitStatus("idle-suspended"));

    expect(screen.getByText(/sandbox suspended/i)).toBeInTheDocument();
    expect(
      screen.getByText(/files in \/workspace are preserved/i),
    ).toBeInTheDocument();
    // Watching the panel must not keep the sandbox alive — copy is explicit.
    expect(
      screen.getByText(/watching the panel does not keep the sandbox alive/i),
    ).toBeInTheDocument();
  });

  it("shows distinct copy for unauthorized vs disconnected", async () => {
    const { rerender } = render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emitStatus("unauthorized"));
    expect(
      screen.getByText(/you don't have access to this sandbox/i),
    ).toBeInTheDocument();

    rerender(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    act(() => emitStatus("disconnected"));
    expect(screen.getByText(/^disconnected$/i)).toBeInTheDocument();
  });

  it("surfaces the backend-provided error message in the error state", async () => {
    render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emitStatus("error", "ImagePullBackOff: registry unreachable"));
    expect(
      screen.getByText(/imagepullbackoff: registry unreachable/i),
    ).toBeInTheDocument();
  });

  it("ignores output frames for other conversations", async () => {
    render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });
    // Wrong conversation id — should not throw or surface anything.
    expect(() =>
      act(() => {
        for (const handler of subscriptions.get("sandbox_terminal_output") ??
          []) {
          handler({
            type: "sandbox_terminal_output",
            payload: { conversationId: "other", data: "noise" },
          });
        }
      }),
    ).not.toThrow();
    // And valid output for our conversation still flows.
    expect(() => act(() => emitOutput("hi\r\n"))).not.toThrow();
  });

  it("uploads dropped files via the mutation", async () => {
    render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={() => {}} conversationId="c1" />,
      ),
    );
    await act(async () => {
      await Promise.resolve();
    });

    const panel = screen.getByTestId("sandbox-terminal-panel");
    const file = new File(["col1,col2\n1,2\n"], "data.csv", {
      type: "text/csv",
    });

    // Simulate the drop. Drag enter / over emit the overlay; drop fires the
    // mutation.
    fireEvent.dragEnter(panel, { dataTransfer: { types: ["Files"] } });
    fireEvent.dragOver(panel, { dataTransfer: { types: ["Files"] } });
    fireEvent.drop(panel, {
      dataTransfer: { files: [file], types: ["Files"] },
    });

    expect(mockUploadMutate).toHaveBeenCalledTimes(1);
    expect(mockUploadMutate).toHaveBeenCalledWith({
      conversationId: "c1",
      file,
    });
  });

  it("does not upload when the panel has no conversation", async () => {
    render(
      wrap(
        <SandboxTerminalPanel
          isOpen
          onClose={() => {}}
          conversationId={undefined}
        />,
      ),
    );
    const panel = screen.getByTestId("sandbox-terminal-panel");
    const file = new File(["x"], "x.txt");
    fireEvent.drop(panel, {
      dataTransfer: { files: [file], types: ["Files"] },
    });
    expect(mockUploadMutate).not.toHaveBeenCalled();
  });

  it("invokes onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    render(
      wrap(
        <SandboxTerminalPanel isOpen onClose={onClose} conversationId="c1" />,
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: /close sandbox terminal/i }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
