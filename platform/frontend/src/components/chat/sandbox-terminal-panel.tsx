"use client";

import type {
  SandboxTerminalOutputMessage,
  SandboxTerminalState,
  SandboxTerminalStatusMessage,
} from "@shared";
import { TerminalSquare, Upload, X } from "lucide-react";
import {
  type DragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import {
  SANDBOX_FILE_UPLOAD_MAX_BYTES,
  useSandboxFileUpload,
} from "@/lib/sandbox/sandbox.query";
import { cn } from "@/lib/utils";
import websocketService from "@/lib/websocket/websocket";

interface SandboxTerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  conversationId: string | undefined;
}

// `idle` is a frontend-only state for "no sandbox provisioned yet, agent
// will create one on first tool call". The seven server-driven states from
// SANDBOX_TERMINAL_STATES never include `idle`.
type PanelState = SandboxTerminalState | "idle";

export function SandboxTerminalPanel({
  isOpen,
  onClose,
  conversationId,
}: SandboxTerminalPanelProps) {
  if (!isOpen) return null;

  return (
    <SandboxTerminalPanelInner
      conversationId={conversationId}
      onClose={onClose}
    />
  );
}

function SandboxTerminalPanelInner({
  conversationId,
  onClose,
}: {
  conversationId: string | undefined;
  onClose: () => void;
}) {
  const terminalHostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<import("@xterm/xterm").Terminal | null>(null);
  const fitAddonRef = useRef<import("@xterm/addon-fit").FitAddon | null>(null);
  const [panelState, setPanelState] = useState<PanelState>(
    conversationId ? "connecting" : "idle",
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isDragActive, setDragActive] = useState(false);
  const uploadMutation = useSandboxFileUpload();

  // Reset state when the conversation changes — without this, leftover
  // `connected` state from the previous chat survives into the next one
  // until the WS catches up, which would let the user think the new
  // conversation already has a running sandbox.
  useEffect(() => {
    setPanelState(conversationId ? "connecting" : "idle");
    setErrorMessage(null);
  }, [conversationId]);

  // Subscribe to the per-conversation terminal stream. The `disposed` flag
  // and the cleanup function below are what guard against double-mount in
  // StrictMode — do NOT add a cross-render `initializedRef` gate here, since
  // a stale `true` from a prior mount silently swallows the second mount's
  // subscribe and the panel ends up Disconnected forever.
  useEffect(() => {
    if (!conversationId || !terminalHostRef.current) {
      return;
    }

    let disposed = false;
    const cleanups: Array<() => void> = [];

    const init = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      await import("@xterm/xterm/css/xterm.css");

      if (disposed || !terminalHostRef.current) return;

      const fitAddon = new FitAddon();
      const terminal = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        fontSize: 12,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        theme: {
          background: "#020617",
          foreground: "#e2e8f0",
          cursor: "#020617",
        },
        scrollback: 10000,
      });
      terminal.loadAddon(fitAddon);
      terminal.open(terminalHostRef.current);

      requestAnimationFrame(() => {
        if (!disposed) {
          try {
            fitAddon.fit();
          } catch {
            // Container not measured yet.
          }
        }
      });

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      websocketService.connect();

      const sendSubscribe = () => {
        const dims = fitAddon.proposeDimensions();
        websocketService.send({
          type: "subscribe_sandbox_terminal",
          payload: {
            conversationId,
            cols: dims?.cols ?? 80,
            rows: dims?.rows ?? 24,
          },
        });
      };

      const unsubStatus = websocketService.subscribe(
        "sandbox_terminal_status",
        (message: SandboxTerminalStatusMessage) => {
          if (message.payload.conversationId !== conversationId || disposed) {
            return;
          }
          setPanelState(message.payload.state);
          setErrorMessage(message.payload.error ?? null);
        },
      );
      cleanups.push(unsubStatus);

      const unsubOutput = websocketService.subscribe(
        "sandbox_terminal_output",
        (message: SandboxTerminalOutputMessage) => {
          if (message.payload.conversationId !== conversationId || disposed) {
            return;
          }
          terminal.write(message.payload.data);
        },
      );
      cleanups.push(unsubOutput);

      sendSubscribe();

      const resizeObserver = new ResizeObserver(() => {
        if (disposed) return;
        try {
          fitAddon.fit();
          const dims = fitAddon.proposeDimensions();
          if (dims?.cols != null && dims?.rows != null) {
            websocketService.send({
              type: "sandbox_terminal_resize",
              payload: {
                conversationId,
                cols: dims.cols,
                rows: dims.rows,
              },
            });
          }
        } catch {
          // Ignore fit errors during transitions.
        }
      });
      resizeObserver.observe(terminalHostRef.current);
      cleanups.push(() => resizeObserver.disconnect());
    };

    const initPromise = init();

    return () => {
      disposed = true;
      void initPromise.then(() => {
        // Unsubscribe before tearing down — backend stops dialing ttyd.
        websocketService.send({
          type: "unsubscribe_sandbox_terminal",
          payload: { conversationId },
        });
        for (const fn of cleanups) fn();
        terminalRef.current?.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      });
    };
  }, [conversationId]);

  const handleDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
      setDragActive(true);
    }
  }, []);

  const handleDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer?.types?.includes("Files")) {
      event.preventDefault();
    }
  }, []);

  const handleDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    // Only clear when the cursor really leaves the panel (not when it
    // crosses into a child element, which fires `dragleave` on the parent).
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
      return;
    }
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragActive(false);
      if (!conversationId) return;
      const files = Array.from(event.dataTransfer?.files ?? []);
      for (const file of files) {
        uploadMutation.mutate({ conversationId, file });
      }
    },
    [conversationId, uploadMutation],
  );

  const showTerminal =
    panelState === "connected" ||
    panelState === "connecting" ||
    panelState === "provisioning";

  return (
    <section
      aria-label="Sandbox terminal"
      className="flex flex-col bg-background h-full overflow-hidden border-t relative"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="sandbox-terminal-panel"
    >
      {/* Header */}
      <div className="flex flex-col px-2 py-3 border-b flex-shrink-0">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <TerminalSquare className="h-4 w-4 text-muted-foreground" />
            <span className="text-xs font-medium">Sandbox Terminal</span>
            <StatusDot state={panelState} />
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={onClose}
            title="Close"
            aria-label="Close sandbox terminal"
          >
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 relative bg-slate-950">
        {!showTerminal && (
          <PanelStatePlaceholder
            state={panelState}
            errorMessage={errorMessage}
          />
        )}
        <div
          className={cn(
            "absolute inset-0 p-3",
            !showTerminal && "pointer-events-none opacity-0",
          )}
        >
          <div ref={terminalHostRef} className="h-full" />
        </div>

        {isDragActive && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-slate-950/80 border-2 border-dashed border-emerald-400 m-2 rounded-md pointer-events-none">
            <div className="flex flex-col items-center gap-2 text-emerald-400">
              <Upload className="h-6 w-6" />
              <div className="text-sm font-medium">Drop file to upload</div>
              <div className="text-xs">Up to 16 MiB, lands in /workspace</div>
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="px-3 py-1.5 border-t text-[10px] text-muted-foreground flex items-center justify-between flex-shrink-0">
        <span className="font-mono">
          Read-only · Cmd-Shift-C / Ctrl-Shift-C to copy
        </span>
        {uploadMutation.isPending && <span>Uploading…</span>}
      </div>
    </section>
  );
}

function StatusDot({ state }: { state: PanelState }) {
  const map: Record<PanelState, { className: string; title: string }> = {
    idle: { className: "bg-slate-500", title: "No sandbox yet" },
    provisioning: {
      className: "bg-amber-400 animate-pulse",
      title: "Provisioning",
    },
    connecting: {
      className: "bg-amber-400 animate-pulse",
      title: "Connecting",
    },
    connected: { className: "bg-emerald-500", title: "Connected" },
    "idle-suspended": { className: "bg-slate-400", title: "Suspended" },
    disconnected: { className: "bg-rose-500", title: "Disconnected" },
    unauthorized: { className: "bg-rose-500", title: "Unauthorized" },
    error: { className: "bg-rose-500", title: "Error" },
  };
  const { className, title } = map[state];
  return (
    <span
      className={cn("w-2 h-2 rounded-full", className)}
      title={title}
      data-testid={`sandbox-status-${state}`}
    />
  );
}

function PanelStatePlaceholder({
  state,
  errorMessage,
}: {
  state: PanelState;
  errorMessage: string | null;
}): ReactNode {
  const content = describeState(state, errorMessage);
  return (
    <div className="absolute inset-0 z-0 flex items-center justify-center p-6 text-center">
      <div className="flex flex-col items-center gap-1 max-w-xs">
        <div
          className={cn(
            "text-sm font-medium",
            content.tone === "danger" && "text-rose-400",
            content.tone === "warn" && "text-amber-400",
            content.tone === "muted" && "text-slate-400",
          )}
        >
          {content.title}
        </div>
        <div className="text-xs text-slate-400 leading-relaxed">
          {content.body}
        </div>
      </div>
    </div>
  );
}

function describeState(
  state: PanelState,
  errorMessage: string | null,
): { title: string; body: string; tone: "muted" | "warn" | "danger" } {
  switch (state) {
    case "idle":
      return {
        title: "No sandbox running yet",
        body: "Agent will provision a sandbox on first use. Drop a file here to share it once the sandbox is ready.",
        tone: "muted",
      };
    case "provisioning":
      return {
        title: "Provisioning sandbox…",
        body: "Spinning up a fresh Linux pod with the toolchain pre-installed. First-time provisioning can take up to ~90 seconds.",
        tone: "warn",
      };
    case "connecting":
      return {
        title: "Connecting…",
        body: "Attaching to the live terminal stream.",
        tone: "warn",
      };
    case "idle-suspended":
      return {
        title: "Sandbox suspended",
        body: "Suspended after 15 minutes without agent activity. Files in /workspace are preserved; PTY sessions and scrollback are reset. The agent will resume automatically on the next tool call. Watching the panel does not keep the sandbox alive.",
        tone: "muted",
      };
    case "disconnected":
      return {
        title: "Disconnected",
        body:
          errorMessage ??
          "The terminal stream closed. Re-open the chat or wait for the agent's next tool call to reconnect.",
        tone: "danger",
      };
    case "unauthorized":
      return {
        title: "You don't have access to this sandbox",
        body: "The conversation owner must be signed in to view its sandbox.",
        tone: "danger",
      };
    case "error":
      return {
        title: "Sandbox error",
        body: errorMessage ?? "The sandbox could not be reached.",
        tone: "danger",
      };
    case "connected":
      // The terminal renders at this point; the placeholder is hidden.
      return { title: "", body: "", tone: "muted" };
  }
}

export { SANDBOX_FILE_UPLOAD_MAX_BYTES };
