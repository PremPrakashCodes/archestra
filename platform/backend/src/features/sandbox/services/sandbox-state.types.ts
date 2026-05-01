import { z } from "zod";

/**
 * Public surface of the sandbox runtime to the rest of the backend.
 *
 * The state lives in `conversation_sandbox`. The manager is responsible for
 * keeping the row in sync with what is actually present in the K8s namespace.
 */
export const SandboxConnectionInfoSchema = z.object({
  conversationId: z.string(),
  mcpServerId: z.string(),
  state: z.enum([
    "provisioning",
    "running",
    "idle-suspended",
    "stopped",
    "error",
  ]),
  /** Service DNS name (in-cluster) plus port for the in-pod MCP server. */
  mcpEndpointUrl: z.string().nullable(),
  /** Service DNS name plus port for ttyd (terminal proxy). */
  ttyEndpointUrl: z.string().nullable(),
  podName: z.string().nullable(),
  pvcName: z.string().nullable(),
  lastActivityAt: z.date().nullable(),
  idleDeadlineAt: z.date().nullable(),
  provisioningError: z.string().nullable(),
});

export type SandboxConnectionInfo = z.infer<typeof SandboxConnectionInfoSchema>;

export const ProvisionSandboxInputSchema = z.object({
  conversationId: z.string(),
  mcpServerId: z.string(),
  /**
   * Override the docker image (otherwise the manager resolves it from the
   * mcp_server's catalog `localConfig.dockerImage` or backend default).
   */
  dockerImage: z.string().optional(),
  /** Override per-catalog idle timeout in minutes; falls back to backend default. */
  idleTimeoutMinutes: z.number().int().positive().optional(),
  /** Override per-catalog PVC size in GiB; falls back to backend default. */
  pvcSizeGiB: z.number().int().positive().optional(),
});

export type ProvisionSandboxInput = z.infer<typeof ProvisionSandboxInputSchema>;

/**
 * Errors a sandbox operation can surface to upstream callers (chat path,
 * file-upload route, terminal WS proxy). Plain string discriminator keeps the
 * shape JSON-serialisable for frontend consumption.
 */
type SandboxRuntimeErrorCode =
  | "SANDBOX_DISABLED"
  | "SANDBOX_NOT_FOUND"
  | "SANDBOX_NOT_READY"
  | "SANDBOX_PROVISIONING_FAILED"
  | "SANDBOX_RUNTIME_UNAVAILABLE";

export class SandboxRuntimeError extends Error {
  constructor(
    public readonly code: SandboxRuntimeErrorCode,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SandboxRuntimeError";
  }
}
