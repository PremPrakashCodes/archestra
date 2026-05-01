import { buildFullToolName } from "./utils";

/**
 * Fixed UUID for the built-in MCP code-execution sandbox catalog entry.
 * Stable across server restarts so the catalog row is upserted, not duplicated.
 * Must be a valid UUID (version 4, variant 8/9/a/b) for Zod validation.
 */
export const SANDBOX_MCP_CATALOG_ID = "00000000-0000-4000-8000-000000000003";

/**
 * Catalog name shown in the MCP registry UI for the sandbox.
 * Mirrors the `microsoft__playwright-mcp` naming pattern so the registry card
 * groups it alongside other built-in vendor MCP servers.
 */
export const SANDBOX_MCP_SERVER_NAME = buildFullToolName(
  "archestra",
  "sandbox",
);

export function isSandboxCatalogItem(id: string): boolean {
  return id === SANDBOX_MCP_CATALOG_ID;
}

export interface SandboxToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Static catalog of tools served by the sandbox MCP server image. Pre-seeded
 * at platform startup so users can assign sandbox tools to agents without the
 * platform having to introspect a long-lived sandbox pod (sandboxes are
 * provisioned per chat conversation by `SandboxRuntimeManager`).
 *
 * Mirrors the Zod schemas in `mcp_server_sandbox_docker_image/in_pod_server/src/tools/`.
 * If a tool's signature changes there, update the matching entry here.
 */
export const SANDBOX_MCP_TOOL_DEFINITIONS: readonly SandboxToolDefinition[] = [
  {
    name: "file_read",
    description:
      "Read a file inside /workspace. Returns content as utf8 (default) or base64.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        maxBytes: { type: "integer", exclusiveMinimum: 0 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "file_write",
    description:
      "Write a file inside /workspace. Encoding defaults to utf8; pass base64 for binary content. Existing files are overwritten.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        content: { type: "string" },
        encoding: { type: "string", enum: ["utf8", "base64"] },
        createParents: {
          type: "boolean",
          description:
            "Create parent directories if missing. Defaults to false.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "file_list",
    description: "List the entries of a directory inside /workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        maxEntries: { type: "integer", exclusiveMinimum: 0 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "file_upload",
    description:
      "Upload a base64-encoded file into /workspace. For larger payloads, use the platform's drag-and-drop panel which streams bytes directly without spending tokens.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        contentBase64: { type: "string" },
        extractIfArchive: {
          type: "boolean",
          description:
            "If true and path ends in .zip, extract to a directory of the same basename. zip-slip checked.",
        },
      },
      required: ["path", "contentBase64"],
      additionalProperties: false,
    },
  },
  {
    name: "file_download",
    description:
      "Read a file inside /workspace and return it base64-encoded. Subject to the download size cap.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "pty_spawn",
    description:
      "Spawn a new PTY session (a tmux window) inside the sandbox. Returns a sessionId used by pty_write / pty_read / pty_kill.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          maxLength: 64,
          description: "Optional human-readable name for the tmux window.",
        },
        cwd: {
          type: "string",
          description:
            "Optional working directory for the new shell. Defaults to /workspace.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "pty_write",
    description:
      "Write text into a PTY session. The text is sent literally (no shell interpretation) and Enter is appended to fire the line.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1 },
        text: { type: "string" },
        sendEnter: {
          type: "boolean",
          description:
            "If false, do not append Enter after the text. Defaults to true.",
        },
      },
      required: ["sessionId", "text"],
      additionalProperties: false,
    },
  },
  {
    name: "pty_read",
    description:
      "Read incremental output from a PTY session since the last read. Returns the new bytes plus the updated offset.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1 },
        scrollback: {
          type: "integer",
          exclusiveMinimum: 0,
          maximum: 20000,
          description: "Lines of scrollback to capture. Defaults to 2000.",
        },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
  {
    name: "pty_list",
    description: "List all active PTY sessions.",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "pty_kill",
    description: "Terminate a PTY session. Idempotent.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", minLength: 1 },
      },
      required: ["sessionId"],
      additionalProperties: false,
    },
  },
] as const;
