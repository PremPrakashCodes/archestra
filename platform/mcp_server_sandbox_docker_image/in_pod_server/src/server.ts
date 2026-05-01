// In-pod MCP server entrypoint.
//
// Listens on 0.0.0.0:8080, route /mcp. Bearer auth on every request,
// backed by a Kubernetes Secret-mounted file at /secrets/bearer-token
// with fs.watch hot-reload. Tools brokered through tmux on
// /var/run/tmux/sandbox.sock and a /workspace path-guard.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { logger } from "./logger.js";
import { TokenStore, extractBearer } from "./auth.js";
import { ActivityProbe } from "./activity.js";
import { TmuxClient } from "./tmux-client.js";
import { PtyManager, registerPtyTools } from "./tools/pty.js";
import { FileManager, registerFileTools } from "./tools/file.js";

interface CliArgs {
  port: number;
  host: string;
  tmuxSocket: string;
  tmuxSession: string;
  activityFile: string;
  workspace: string;
  bearerTokenFile: string;
  uploadMaxMib: number;
  downloadMaxMib: number;
}

const args = parseCliArgs();

void main(args).catch((err) => {
  logger.error(`fatal: ${(err as Error).message}`, {
    stack: (err as Error).stack,
  });
  process.exit(1);
});

async function main(opts: CliArgs): Promise<void> {
  const tokens = new TokenStore(opts.bearerTokenFile);
  if (existsSync(opts.bearerTokenFile)) {
    await tokens.start();
  } else {
    // Allow the server to come up without a token file present (e.g.
    // in `docker run` smoke tests). The server will still reject
    // requests until the file appears and is reloaded.
    logger.warn(`auth: bearer-token file not present yet`, {
      path: opts.bearerTokenFile,
    });
  }

  const tmux = new TmuxClient({
    socket: opts.tmuxSocket,
    session: opts.tmuxSession,
  });
  const activity = new ActivityProbe(opts.activityFile);

  const ptyManager = new PtyManager({
    tmux,
    activity,
    workspace: opts.workspace,
  });
  const fileManager = new FileManager({
    workspace: opts.workspace,
    activity,
    uploadMaxBytes: opts.uploadMaxMib * 1024 * 1024,
    downloadMaxBytes: opts.downloadMaxMib * 1024 * 1024,
  });

  // Per-request McpServer + transport. Stateless StreamableHTTP refuses
  // to handle a second request on the same transport instance because
  // request-id collisions between clients are unsafe to ignore. The
  // managers (PtyManager / FileManager) hold the real state and are
  // shared across requests; spinning up an McpServer and registering
  // tools per request is cheap (in-memory object construction).
  const buildMcp = () => {
    const mcp = new McpServer(
      {
        name: "archestra-sandbox-in-pod",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );
    registerPtyTools(mcp, ptyManager);
    registerFileTools(mcp, fileManager);
    return mcp;
  };

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res, buildMcp, tokens);
  });
  httpServer.listen(opts.port, opts.host, () => {
    logger.info(`in-pod MCP server listening`, {
      host: opts.host,
      port: opts.port,
      workspace: opts.workspace,
    });
  });

  // Graceful shutdown — the supervisor sends SIGTERM when the idle
  // daemon kicks in (or K8s evicts the pod).
  const shutdown = (signal: string) => {
    logger.info(`shutdown received`, { signal });
    httpServer.close(() => {
      tokens.stop();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function handleHttp(
  req: IncomingMessage,
  res: ServerResponse,
  buildMcp: () => McpServer,
  tokens: TokenStore,
): Promise<void> {
  // Lightweight liveness probe so the supervisor / K8s livenessProbe
  // can hit something cheap that doesn't require a valid bearer.
  if (req.method === "GET" && req.url === "/healthz") {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (!req.url || !req.url.startsWith("/mcp")) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const presented = extractBearer(req.headers.authorization);
  if (!presented || !tokens.verify(presented)) {
    res.statusCode = 401;
    res.setHeader("content-type", "application/json");
    res.setHeader("www-authenticate", `Bearer realm="archestra-sandbox"`);
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: { code: -32000, message: "unauthorized" },
        id: null,
      }),
    );
    return;
  }

  const mcp = buildMcp();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    logger.error(`request handler failed`, {
      url: req.url,
      error: (err as Error).message,
    });
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        }),
      );
    }
  }
}

function parseCliArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const get = (flag: string, fallback?: string): string | undefined => {
    const idx = argv.indexOf(flag);
    if (idx === -1) return fallback;
    return argv[idx + 1] ?? fallback;
  };
  const getInt = (flag: string, fallback: number): number => {
    const raw = get(flag);
    if (raw === undefined) return fallback;
    const n = Number.parseInt(raw, 10);
    if (Number.isNaN(n) || n <= 0) {
      throw new Error(`invalid integer for ${flag}: ${raw}`);
    }
    return n;
  };
  return {
    port: getInt("--port", 8080),
    host: get("--host", "0.0.0.0") ?? "0.0.0.0",
    tmuxSocket: get("--tmux-socket", "/var/run/tmux/sandbox.sock") ?? "",
    tmuxSession: get("--tmux-session", "sandbox") ?? "sandbox",
    activityFile: get("--activity-file", "/var/run/sandbox/activity") ?? "",
    workspace: get("--workspace", "/workspace") ?? "/workspace",
    bearerTokenFile: get("--bearer-token-file", "/secrets/bearer-token") ?? "",
    uploadMaxMib: getInt("--upload-max-mib", 16),
    downloadMaxMib: getInt("--download-max-mib", 64),
  };
}
