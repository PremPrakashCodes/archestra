import type * as k8s from "@kubernetes/client-node";
import config from "@/config";
import {
  constructSandboxNames,
  type GenerateSandboxSpecInput,
  generateSandboxSpec,
  SANDBOX_MCP_PORT,
  SANDBOX_TTY_PORT,
  type SandboxServiceType,
} from "@/k8s/mcp-server-runtime/sandbox-spec";
import {
  createK8sClients,
  isK8sAlreadyExistsError,
  isK8sNotFoundError,
  loadKubeConfig,
} from "@/k8s/shared";
import logger from "@/logging";
import {
  ConversationSandboxModel,
  InternalMcpCatalogModel,
  McpServerModel,
} from "@/models";
import type { ConversationSandbox, SandboxState } from "@/types";
import {
  type ProvisionSandboxInput,
  ProvisionSandboxInputSchema,
  type SandboxConnectionInfo,
  SandboxRuntimeError,
} from "./sandbox-state.types";

const SECONDS_PER_MINUTE = 60;

/**
 * Subset of K8s clients the manager needs. Injectable so tests don't have to
 * stand up a real cluster.
 *
 * `exec` is optional because the WS-bridge / upload-route tests inject only
 * the API clients they care about; in production it is always populated.
 */
interface SandboxK8sClients {
  coreApi: k8s.CoreV1Api;
  batchApi: k8s.BatchV1Api;
  exec?: k8s.Exec;
}

interface SandboxRuntimeOptions {
  /**
   * Resolves the K8s clients lazily. Returning `null` puts the manager into
   * "runtime unavailable" mode (operations throw `SANDBOX_RUNTIME_UNAVAILABLE`).
   */
  loadClients?: () => {
    clients: SandboxK8sClients;
    namespace: string;
  } | null;
  /**
   * Cold-start readiness wait. Polls Pod phase every `pollIntervalMs` until it
   * either reaches `Running` or the `timeoutMs` elapses.
   */
  readiness?: {
    pollIntervalMs: number;
    timeoutMs: number;
  };
  /**
   * Optional clock injection for deterministic test behaviour around
   * `lastActivityAt`/`idleDeadlineAt`.
   */
  now?: () => Date;
}

const DEFAULT_READINESS_POLL = {
  pollIntervalMs: 1_000,
  timeoutMs: 90_000,
};

/**
 * Owns provisioning, idle bookkeeping, resume, and teardown of conversation-
 * scoped sandbox pods. The chat path calls `provisionForConversation` lazily
 * before the first sandbox tool execution; the conversation delete hook calls
 * `destroyForConversation`.
 */
export class SandboxRuntimeManager {
  private readonly inflightProvisions = new Map<
    string,
    Promise<ConversationSandbox>
  >();
  private readonly loadClients: NonNullable<
    SandboxRuntimeOptions["loadClients"]
  >;
  private readonly readiness: NonNullable<SandboxRuntimeOptions["readiness"]>;
  private readonly now: NonNullable<SandboxRuntimeOptions["now"]>;
  private cachedRuntime:
    | { clients: SandboxK8sClients; namespace: string }
    | null
    | undefined = undefined;

  constructor(options: SandboxRuntimeOptions = {}) {
    this.loadClients = options.loadClients ?? defaultLoadClients;
    this.readiness = options.readiness ?? DEFAULT_READINESS_POLL;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * True when the manager has K8s credentials and the operator enabled the
   * sandbox feature flag. Frontend gating uses this via `/api/config`.
   */
  isEnabled(): boolean {
    if (!config.orchestrator.sandbox.enabled) {
      return false;
    }
    return this.tryGetRuntime() !== null;
  }

  /**
   * Idempotent provisioning. First caller creates Secret → PVC → Service → Job
   * and waits for the pod to reach `Running`. Concurrent callers share the
   * in-flight promise. Returns the final `conversation_sandbox` row.
   */
  async provisionForConversation(
    input: ProvisionSandboxInput,
  ): Promise<ConversationSandbox> {
    const parsed = ProvisionSandboxInputSchema.parse(input);
    const { conversationId } = parsed;

    const existingFlight = this.inflightProvisions.get(conversationId);
    if (existingFlight) {
      return existingFlight;
    }

    const flight = this.runProvision(parsed).finally(() => {
      this.inflightProvisions.delete(conversationId);
    });
    this.inflightProvisions.set(conversationId, flight);
    return flight;
  }

  /**
   * Bumps `lastActivityAt` on the sandbox row. Called from the chat path after
   * each successful sandbox tool execution. Fire-and-forget at the call site —
   * activity tracking should never block a tool response.
   */
  async markActivity(params: { conversationId: string }): Promise<void> {
    await ConversationSandboxModel.bumpLastActivity(
      params.conversationId,
      this.now(),
    );
  }

  /**
   * Resume a sandbox that was suspended by the in-pod idle daemon. PVC and
   * Secret persist by name; we re-create the Job (and Service if missing) and
   * wait for readiness. Errors a row already in `error` state instead of
   * silently retrying.
   */
  async resumeIfSuspended(params: {
    conversationId: string;
  }): Promise<ConversationSandbox> {
    const { conversationId } = params;
    const row =
      await ConversationSandboxModel.findByConversationId(conversationId);
    if (!row) {
      throw new SandboxRuntimeError(
        "SANDBOX_NOT_FOUND",
        `No sandbox provisioned for conversation ${conversationId}`,
      );
    }
    if (row.state === "error") {
      throw new SandboxRuntimeError(
        "SANDBOX_PROVISIONING_FAILED",
        row.provisioningError ??
          "Sandbox is in error state; manual intervention required",
      );
    }
    if (row.state === "running") {
      return row;
    }

    return this.provisionForConversation({
      conversationId,
      mcpServerId: row.mcpServerId,
    });
  }

  /**
   * Best-effort teardown invoked from the conversation delete hook. Deletes
   * Job (with foreground propagation so the Pod is gone before PVC delete),
   * Service, PVC, and finally the row. Errors are logged, never thrown, so a
   * transient K8s failure does not block conversation deletion.
   */
  async destroyForConversation(params: {
    conversationId: string;
  }): Promise<void> {
    const { conversationId } = params;
    const runtime = this.tryGetRuntime();

    const row =
      await ConversationSandboxModel.findByConversationId(conversationId);
    const names = constructSandboxNames(conversationId);

    if (runtime) {
      const { clients, namespace } = runtime;
      await this.deleteJob(clients.batchApi, namespace, names.job);
      await this.deleteService(clients.coreApi, namespace, names.service);
      await this.deletePvc(clients.coreApi, namespace, names.pvc);
    } else if (row) {
      logger.warn(
        { conversationId },
        "Sandbox runtime unavailable; deleting only the conversation_sandbox row",
      );
    }

    await ConversationSandboxModel.deleteByConversationId(conversationId);
  }

  /**
   * Read current sandbox state with lazy idle detection. If the row is
   * `running` but the K8s Job no longer exists, transitions to
   * `idle-suspended` so the frontend can render the suspend copy without a
   * dedicated reaper job.
   */
  async getState(params: {
    conversationId: string;
  }): Promise<SandboxConnectionInfo | null> {
    const { conversationId } = params;
    const row =
      await ConversationSandboxModel.findByConversationId(conversationId);
    if (!row) {
      return null;
    }

    const runtime = this.tryGetRuntime();
    let effectiveState: SandboxState = row.state;
    if (runtime && row.state === "running") {
      const exists = await this.jobExists(
        runtime.clients.batchApi,
        runtime.namespace,
        constructSandboxNames(conversationId).job,
      );
      if (!exists) {
        effectiveState = "idle-suspended";
        await ConversationSandboxModel.update(conversationId, {
          state: effectiveState,
        });
      }
    }

    return this.toConnectionInfo({ ...row, state: effectiveState }, runtime);
  }

  /**
   * Resolve the in-cluster (or local-dev NodePort) connection details the WS
   * bridge needs to dial ttyd. Returns `null` when the sandbox is not
   * reachable (no row, runtime unavailable, or service NodePort missing).
   */
  async resolveTerminalConnection(params: {
    conversationId: string;
  }): Promise<{ wsUrl: string } | null> {
    const endpoint = await this.resolveSandboxEndpoint({
      conversationId: params.conversationId,
      port: SANDBOX_TTY_PORT,
      portName: "tty",
      protocol: "ws",
    });
    if (!endpoint) return null;
    return { wsUrl: `${endpoint}/ws` };
  }

  /**
   * Resolve the in-cluster (or local-dev NodePort) base URL for the in-pod
   * MCP server. The upload route uses this to issue MCP file_upload calls
   * (and to verify readiness when the upload arrives mid-resume).
   */
  async resolveMcpConnection(params: {
    conversationId: string;
  }): Promise<{ baseUrl: string } | null> {
    const endpoint = await this.resolveSandboxEndpoint({
      conversationId: params.conversationId,
      port: SANDBOX_MCP_PORT,
      portName: "mcp",
      protocol: "http",
    });
    if (!endpoint) return null;
    return { baseUrl: endpoint };
  }

  /**
   * The K8s API clients used by the manager. Exposed so adjacent sandbox
   * services (e.g. the upload route's `Exec` channel) can reuse the same
   * cached clients without reloading the kubeconfig.
   */
  getRuntime(): { clients: SandboxK8sClients; namespace: string } | null {
    return this.tryGetRuntime();
  }

  // ===
  // Internals
  // ===

  private async resolveSandboxEndpoint(params: {
    conversationId: string;
    port: number;
    portName: "mcp" | "tty";
    protocol: "http" | "ws";
  }): Promise<string | null> {
    const runtime = this.tryGetRuntime();
    if (!runtime) return null;
    const names = constructSandboxNames(params.conversationId);

    if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
      const host = `${names.service}.${runtime.namespace}.svc.${config.orchestrator.kubernetes.clusterDomain}`;
      return `${params.protocol}://${host}:${params.port}`;
    }

    try {
      const service = await runtime.clients.coreApi.readNamespacedService({
        name: names.service,
        namespace: runtime.namespace,
      });
      const portEntry = service.spec?.ports?.find(
        (p) => p.name === params.portName,
      );
      const nodePort = portEntry?.nodePort;
      if (!nodePort) return null;
      const host = config.orchestrator.kubernetes.k8sNodeHost ?? "localhost";
      return `${params.protocol}://${host}:${nodePort}`;
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return null;
      }
      logger.warn(
        { err: error, conversationId: params.conversationId },
        "Failed to read sandbox Service for endpoint resolution",
      );
      return null;
    }
  }

  private async runProvision(
    input: ProvisionSandboxInput,
  ): Promise<ConversationSandbox> {
    const runtime = this.requireRuntime();
    const { clients, namespace } = runtime;
    const { conversationId, mcpServerId } = input;

    const mcpServer = await McpServerModel.findById(mcpServerId);
    if (!mcpServer) {
      throw new SandboxRuntimeError(
        "SANDBOX_NOT_FOUND",
        `MCP server ${mcpServerId} not found`,
      );
    }
    const catalogItem = mcpServer.catalogId
      ? await InternalMcpCatalogModel.findById(mcpServer.catalogId)
      : null;
    const localConfig = catalogItem?.localConfig ?? null;
    if (!localConfig || localConfig.runtimeProfile !== "sandbox") {
      throw new SandboxRuntimeError(
        "SANDBOX_PROVISIONING_FAILED",
        `MCP server ${mcpServerId} is not configured with runtimeProfile=sandbox`,
      );
    }

    const dockerImage =
      input.dockerImage ??
      localConfig.dockerImage ??
      config.orchestrator.sandbox.baseImage;
    const idleTimeoutMinutes =
      input.idleTimeoutMinutes ??
      localConfig.sandbox?.idleTimeoutMinutes ??
      config.orchestrator.sandbox.idleDefaultMinutes;
    const pvcSizeGiB =
      input.pvcSizeGiB ??
      localConfig.sandbox?.pvcSizeGiB ??
      parsePvcSizeGiB(config.orchestrator.sandbox.pvcDefaultSize) ??
      10;
    const idleHardCapHours = config.orchestrator.sandbox.idleHardCapHours;
    const pvcStorageClass =
      config.orchestrator.sandbox.pvcStorageClass ?? undefined;
    const serviceType = resolveServiceType();

    const names = constructSandboxNames(conversationId);

    const existing =
      await ConversationSandboxModel.findByConversationId(conversationId);
    if (existing?.state === "running") {
      logger.debug(
        { conversationId, mcpServerId },
        "Sandbox already running; skipping re-provision",
      );
      return existing;
    }

    const provisionStartedAt = this.now();
    const idleDeadlineAt = new Date(
      provisionStartedAt.getTime() +
        idleTimeoutMinutes * SECONDS_PER_MINUTE * 1_000,
    );

    const row = existing
      ? await ConversationSandboxModel.update(conversationId, {
          state: "provisioning",
          podName: null,
          pvcName: names.pvc,
          provisioningError: null,
          idleDeadlineAt,
        })
      : await ConversationSandboxModel.create({
          conversationId,
          mcpServerId,
          state: "provisioning",
          pvcName: names.pvc,
          idleDeadlineAt,
          lastActivityAt: provisionStartedAt,
        });

    if (!row) {
      throw new SandboxRuntimeError(
        "SANDBOX_PROVISIONING_FAILED",
        `Failed to persist conversation_sandbox row for ${conversationId}`,
      );
    }

    const specInput: GenerateSandboxSpecInput = {
      conversationId,
      mcpServerId,
      mcpServerName: mcpServer.name,
      dockerImage,
      idleTimeoutSeconds: idleTimeoutMinutes * SECONDS_PER_MINUTE,
      idleHardCapHours,
      pvcSize: `${pvcSizeGiB}Gi`,
      pvcStorageClassName: pvcStorageClass,
      serviceType,
      mcpNodePort: localConfig.sandbox?.mcpNodePort,
      ttyNodePort: localConfig.sandbox?.ttyNodePort,
      appArmorEnabled: config.orchestrator.sandbox.appArmorEnabled,
    };
    const spec = generateSandboxSpec(specInput);

    try {
      await this.upsertPvc(clients.coreApi, namespace, spec.pvc);
      await this.upsertService(clients.coreApi, namespace, spec.service);
      await this.createJob(clients.batchApi, namespace, spec.job);

      const podName = await this.waitForPodRunning(
        clients.coreApi,
        namespace,
        names.job,
      );

      const updated = await ConversationSandboxModel.update(conversationId, {
        state: "running",
        podName,
        provisioningError: null,
        lastActivityAt: this.now(),
      });
      return updated ?? row;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { err: error, conversationId, mcpServerId },
        "Sandbox provisioning failed",
      );
      await ConversationSandboxModel.update(conversationId, {
        state: "error",
        provisioningError: message,
      });
      if (error instanceof SandboxRuntimeError) {
        throw error;
      }
      throw new SandboxRuntimeError(
        "SANDBOX_PROVISIONING_FAILED",
        message,
        error,
      );
    }
  }

  private async upsertPvc(
    api: k8s.CoreV1Api,
    namespace: string,
    body: k8s.V1PersistentVolumeClaim,
  ): Promise<void> {
    const name = requireResourceName(body, "PersistentVolumeClaim");
    try {
      await api.readNamespacedPersistentVolumeClaim({ name, namespace });
      // PVCs are immutable on most fields once bound; reuse the existing claim.
    } catch (error: unknown) {
      if (!isK8sNotFoundError(error)) {
        throw error;
      }
      await api.createNamespacedPersistentVolumeClaim({ namespace, body });
    }
  }

  private async upsertService(
    api: k8s.CoreV1Api,
    namespace: string,
    body: k8s.V1Service,
  ): Promise<void> {
    const name = requireResourceName(body, "Service");
    try {
      await api.readNamespacedService({ name, namespace });
      // Reuse the existing Service; ports/labels are stable per-conversation.
    } catch (error: unknown) {
      if (!isK8sNotFoundError(error)) {
        throw error;
      }
      await api.createNamespacedService({ namespace, body });
    }
  }

  private async createJob(
    api: k8s.BatchV1Api,
    namespace: string,
    body: k8s.V1Job,
  ): Promise<void> {
    try {
      await api.createNamespacedJob({ namespace, body });
    } catch (error: unknown) {
      // A stale Job from a prior attempt (backend restart, mid-flight crash)
      // would otherwise block re-provisioning forever. Treat AlreadyExists as
      // success and let waitForPodRunning attach to the existing pod.
      if (!isK8sAlreadyExistsError(error)) {
        throw error;
      }
      const name = requireResourceName(body, "Job");
      logger.info(
        { name, namespace },
        "Sandbox Job already exists; reusing existing job",
      );
    }
  }

  private async waitForPodRunning(
    api: k8s.CoreV1Api,
    namespace: string,
    jobName: string,
  ): Promise<string> {
    const deadline = Date.now() + this.readiness.timeoutMs;
    while (Date.now() < deadline) {
      const pods = await api.listNamespacedPod({
        namespace,
        labelSelector: `job-name=${jobName}`,
      });
      const pod = pods.items[0];
      if (pod?.status?.phase === "Running" && pod.metadata?.name) {
        return pod.metadata.name;
      }
      if (pod?.status?.phase === "Failed") {
        throw new SandboxRuntimeError(
          "SANDBOX_PROVISIONING_FAILED",
          `Pod for ${jobName} reached Failed phase: ${pod.status.message ?? "unknown"}`,
        );
      }
      await sleep(this.readiness.pollIntervalMs);
    }
    throw new SandboxRuntimeError(
      "SANDBOX_PROVISIONING_FAILED",
      `Timed out waiting for sandbox pod for ${jobName} to reach Running`,
    );
  }

  private async jobExists(
    api: k8s.BatchV1Api,
    namespace: string,
    name: string,
  ): Promise<boolean> {
    try {
      await api.readNamespacedJob({ name, namespace });
      return true;
    } catch (error: unknown) {
      if (isK8sNotFoundError(error)) {
        return false;
      }
      logger.warn(
        { err: error, name, namespace },
        "Failed to read Job; assuming present",
      );
      return true;
    }
  }

  private async deleteJob(
    api: k8s.BatchV1Api,
    namespace: string,
    name: string,
  ): Promise<void> {
    try {
      await api.deleteNamespacedJob({
        name,
        namespace,
        propagationPolicy: "Foreground",
      });
    } catch (error: unknown) {
      if (!isK8sNotFoundError(error)) {
        logger.warn({ err: error, name }, "Failed to delete sandbox Job");
      }
    }
  }

  private async deleteService(
    api: k8s.CoreV1Api,
    namespace: string,
    name: string,
  ): Promise<void> {
    try {
      await api.deleteNamespacedService({ name, namespace });
    } catch (error: unknown) {
      if (!isK8sNotFoundError(error)) {
        logger.warn({ err: error, name }, "Failed to delete sandbox Service");
      }
    }
  }

  private async deletePvc(
    api: k8s.CoreV1Api,
    namespace: string,
    name: string,
  ): Promise<void> {
    try {
      await api.deleteNamespacedPersistentVolumeClaim({ name, namespace });
    } catch (error: unknown) {
      if (!isK8sNotFoundError(error)) {
        logger.warn({ err: error, name }, "Failed to delete sandbox PVC");
      }
    }
  }

  private requireRuntime(): {
    clients: SandboxK8sClients;
    namespace: string;
  } {
    const runtime = this.tryGetRuntime();
    if (!runtime) {
      throw new SandboxRuntimeError(
        "SANDBOX_RUNTIME_UNAVAILABLE",
        "Sandbox runtime is not available (K8s clients unavailable or feature disabled)",
      );
    }
    return runtime;
  }

  private tryGetRuntime(): {
    clients: SandboxK8sClients;
    namespace: string;
  } | null {
    if (this.cachedRuntime !== undefined) {
      return this.cachedRuntime;
    }
    this.cachedRuntime = this.loadClients() ?? null;
    return this.cachedRuntime;
  }

  private toConnectionInfo(
    row: ConversationSandbox,
    runtime: { namespace: string } | null,
  ): SandboxConnectionInfo {
    const names = constructSandboxNames(row.conversationId);
    const endpoints = runtime
      ? buildEndpoints(names.service, runtime.namespace)
      : { mcp: null, tty: null };
    return {
      conversationId: row.conversationId,
      mcpServerId: row.mcpServerId,
      state: row.state,
      mcpEndpointUrl: endpoints.mcp,
      ttyEndpointUrl: endpoints.tty,
      podName: row.podName ?? null,
      pvcName: row.pvcName ?? null,
      lastActivityAt: row.lastActivityAt ?? null,
      idleDeadlineAt: row.idleDeadlineAt ?? null,
      provisioningError: row.provisioningError ?? null,
    };
  }
}

// Default singleton wired to the real cluster. Tests inject a custom
// `loadClients` callback.
export const sandboxRuntimeManager = new SandboxRuntimeManager();

function defaultLoadClients(): {
  clients: SandboxK8sClients;
  namespace: string;
} | null {
  try {
    const { kubeConfig, namespace } = loadKubeConfig();
    const k8sClients = createK8sClients(kubeConfig, namespace);
    return {
      clients: {
        coreApi: k8sClients.coreApi,
        batchApi: k8sClients.batchApi,
        exec: k8sClients.exec,
      },
      namespace,
    };
  } catch (error) {
    logger.warn({ err: error }, "Sandbox runtime: failed to load K8s clients");
    return null;
  }
}

function resolveServiceType(): SandboxServiceType {
  return config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster
    ? "ClusterIP"
    : "NodePort";
}

function buildEndpoints(
  serviceName: string,
  namespace: string,
): { mcp: string; tty: string } | { mcp: null; tty: null } {
  if (config.orchestrator.kubernetes.loadKubeconfigFromCurrentCluster) {
    const host = `${serviceName}.${namespace}.svc.${config.orchestrator.kubernetes.clusterDomain}`;
    return {
      mcp: `http://${host}:${SANDBOX_MCP_PORT}/mcp`,
      tty: `http://${host}:${SANDBOX_TTY_PORT}`,
    };
  }
  // Local dev returns null: NodePorts are looked up dynamically by the
  // websocket / upload routes via the K8s client when needed.
  return { mcp: null, tty: null };
}

function parsePvcSizeGiB(quantity: string): number | null {
  const match = quantity.trim().match(/^(\d+)\s*Gi$/i);
  if (!match) return null;
  const v = Number.parseInt(match[1] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function requireResourceName(
  body: { metadata?: { name?: string } },
  kind: string,
): string {
  const name = body.metadata?.name;
  if (!name) {
    throw new Error(`Sandbox ${kind} body missing metadata.name`);
  }
  return name;
}
