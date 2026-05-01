import type * as k8s from "@kubernetes/client-node";
import { sanitizeLabelValue } from "@/k8s/shared";

/**
 * Naming and labelling conventions for sandbox-profile MCP servers.
 *
 * Sandboxes are conversation-scoped: a single mcp_server catalog row may have
 * many concurrent sandbox pods, one per (conversationId, mcpServerId) pair.
 * Names are derived from the conversationId so re-provisioning a Job after
 * idle suspension reattaches the same PVC by claim name.
 */
const RUNTIME_LABEL_KEY = "archestra.ai/runtime";
const RUNTIME_LABEL_VALUE = "sandbox";
const CONVERSATION_LABEL_KEY = "archestra.ai/conversation-id";
const APP_LABEL = "mcp-server";

/** Container ports owned by the sandbox image. */
export const SANDBOX_MCP_PORT = 8080;
export const SANDBOX_TTY_PORT = 7681;

const MCP_PORT_NAME = "mcp";
const TTY_PORT_NAME = "tty";

const WORKSPACE_MOUNT_PATH = "/workspace";
const TMP_MOUNT_PATH = "/tmp";
const VAR_RUN_MOUNT_PATH = "/var/run";

const SANDBOX_USER_UID = 1000;
const SANDBOX_USER_GID = 1000;

const DEFAULT_RESOURCE_REQUEST_MEMORY = "512Mi";
const DEFAULT_RESOURCE_REQUEST_CPU = "250m";
const DEFAULT_RESOURCE_LIMIT_MEMORY = "2Gi";
const DEFAULT_RESOURCE_LIMIT_CPU = "2";

const SECONDS_PER_HOUR = 3600;

const SANDBOX_SERVICE_ACCOUNT_NAME = "mcp-sandbox-no-rbac";

export type SandboxServiceType = "ClusterIP" | "NodePort";

/**
 * Inputs required to render a self-contained set of K8s manifests for a
 * conversation-scoped sandbox.
 */
export interface GenerateSandboxSpecInput {
  conversationId: string;
  mcpServerId: string;
  mcpServerName: string;
  dockerImage: string;
  idleTimeoutSeconds: number;
  idleHardCapHours: number;
  pvcSize: string;
  pvcStorageClassName?: string;
  serviceType: SandboxServiceType;
  mcpNodePort?: number;
  ttyNodePort?: number;
  resources?: {
    requests?: { memory?: string; cpu?: string };
    limits?: { memory?: string; cpu?: string };
  };
  nodeSelector?: k8s.V1PodSpec["nodeSelector"] | null;
  tolerations?: k8s.V1Toleration[] | null;
  imagePullSecrets?: Array<{ name: string }>;
  serviceAccountName?: string;
  /**
   * Set the pod's AppArmor profile to RuntimeDefault. Off for clusters
   * whose host kernel doesn't enable AppArmor (typical macOS local dev),
   * since kubelet rejects pods with the annotation/profile in that case.
   * Defaults to true.
   */
  appArmorEnabled?: boolean;
}

interface SandboxSpec {
  names: {
    job: string;
    service: string;
    pvc: string;
  };
  labels: Record<string, string>;
  job: k8s.V1Job;
  service: k8s.V1Service;
  pvc: k8s.V1PersistentVolumeClaim;
}

/**
 * Build the four-manifest set for a conversation-scoped sandbox pod.
 *
 * Catalog config wins over backend defaults: the manager is responsible for
 * resolving final values from `localConfig.sandbox` over `config.orchestrator.sandbox`
 * before calling this function.
 */
export function generateSandboxSpec(
  input: GenerateSandboxSpecInput,
): SandboxSpec {
  validateInput(input);

  const names = constructSandboxNames(input.conversationId);
  const labels = sanitizeLabelValuesOnly({
    app: APP_LABEL,
    [RUNTIME_LABEL_KEY]: RUNTIME_LABEL_VALUE,
    [CONVERSATION_LABEL_KEY]: input.conversationId,
    "mcp-server-id": input.mcpServerId,
    "mcp-server-name": input.mcpServerName,
  });
  const selectorLabels = sanitizeLabelValuesOnly({
    app: APP_LABEL,
    [RUNTIME_LABEL_KEY]: RUNTIME_LABEL_VALUE,
    [CONVERSATION_LABEL_KEY]: input.conversationId,
  });

  return {
    names,
    labels,
    pvc: buildPvc(names.pvc, labels, input.pvcSize, input.pvcStorageClassName),
    service: buildService(
      names.service,
      labels,
      selectorLabels,
      input.serviceType,
      input.mcpNodePort,
      input.ttyNodePort,
    ),
    job: buildJob(names, labels, input),
  };
}

/**
 * Stable naming derivation. The PVC name must persist across Job recreations
 * so a resumed sandbox sees the same /workspace volume.
 */
export function constructSandboxNames(conversationId: string): {
  job: string;
  service: string;
  pvc: string;
} {
  return {
    job: `sandbox-job-${conversationId}`,
    service: `sandbox-svc-${conversationId}`,
    pvc: `sandbox-pvc-${conversationId}`,
  };
}

function validateInput(input: GenerateSandboxSpecInput): void {
  if (!input.conversationId) {
    throw new Error("generateSandboxSpec: conversationId is required");
  }
  if (!input.mcpServerId) {
    throw new Error("generateSandboxSpec: mcpServerId is required");
  }
  if (!input.dockerImage) {
    throw new Error("generateSandboxSpec: dockerImage is required");
  }
  if (input.idleTimeoutSeconds <= 0) {
    throw new Error(
      "generateSandboxSpec: idleTimeoutSeconds must be a positive integer",
    );
  }
  if (input.idleHardCapHours <= 0) {
    throw new Error(
      "generateSandboxSpec: idleHardCapHours must be a positive integer",
    );
  }
  if (!input.pvcSize) {
    throw new Error("generateSandboxSpec: pvcSize is required");
  }
}

function buildPvc(
  name: string,
  labels: Record<string, string>,
  size: string,
  storageClassName?: string,
): k8s.V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: { name, labels },
    spec: {
      accessModes: ["ReadWriteOnce"],
      resources: { requests: { storage: size } },
      ...(storageClassName ? { storageClassName } : {}),
    },
  };
}

function buildService(
  name: string,
  labels: Record<string, string>,
  selector: Record<string, string>,
  serviceType: SandboxServiceType,
  mcpNodePort: number | undefined,
  ttyNodePort: number | undefined,
): k8s.V1Service {
  const ports: k8s.V1ServicePort[] = [
    {
      name: MCP_PORT_NAME,
      protocol: "TCP",
      port: SANDBOX_MCP_PORT,
      targetPort: SANDBOX_MCP_PORT as unknown as k8s.IntOrString,
      ...(mcpNodePort && serviceType === "NodePort"
        ? { nodePort: mcpNodePort }
        : {}),
    },
    {
      name: TTY_PORT_NAME,
      protocol: "TCP",
      port: SANDBOX_TTY_PORT,
      targetPort: SANDBOX_TTY_PORT as unknown as k8s.IntOrString,
      ...(ttyNodePort && serviceType === "NodePort"
        ? { nodePort: ttyNodePort }
        : {}),
    },
  ];

  return {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name, labels },
    spec: {
      type: serviceType,
      selector,
      ports,
    },
  };
}

function buildJob(
  names: { job: string; pvc: string; service: string },
  labels: Record<string, string>,
  input: GenerateSandboxSpecInput,
): k8s.V1Job {
  const podSecurityContext: k8s.V1PodSecurityContext = {
    runAsNonRoot: true,
    runAsUser: SANDBOX_USER_UID,
    runAsGroup: SANDBOX_USER_GID,
    fsGroup: SANDBOX_USER_GID,
    fsGroupChangePolicy: "OnRootMismatch",
    seccompProfile: { type: "RuntimeDefault" },
    ...(input.appArmorEnabled !== false && {
      appArmorProfile: { type: "RuntimeDefault" },
    }),
  };

  const containerSecurityContext: k8s.V1SecurityContext = {
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    readOnlyRootFilesystem: true,
  };

  const volumes: k8s.V1Volume[] = [
    { name: "tmp", emptyDir: {} },
    { name: "var-run", emptyDir: {} },
    {
      name: "workspace",
      persistentVolumeClaim: { claimName: names.pvc },
    },
  ];

  const volumeMounts: k8s.V1VolumeMount[] = [
    { name: "tmp", mountPath: TMP_MOUNT_PATH },
    { name: "var-run", mountPath: VAR_RUN_MOUNT_PATH },
    { name: "workspace", mountPath: WORKSPACE_MOUNT_PATH },
  ];

  const env: k8s.V1EnvVar[] = [
    { name: "IDLE_TIMEOUT_SECONDS", value: String(input.idleTimeoutSeconds) },
  ];

  const resources = mergeResources(input.resources);

  const podSpec: k8s.V1PodSpec = {
    serviceAccountName:
      input.serviceAccountName ?? SANDBOX_SERVICE_ACCOUNT_NAME,
    automountServiceAccountToken: false,
    enableServiceLinks: false,
    restartPolicy: "Never",
    terminationGracePeriodSeconds: 10,
    securityContext: podSecurityContext,
    ...(input.nodeSelector && Object.keys(input.nodeSelector).length > 0
      ? { nodeSelector: input.nodeSelector }
      : {}),
    ...(input.tolerations?.length ? { tolerations: input.tolerations } : {}),
    ...(input.imagePullSecrets?.length
      ? { imagePullSecrets: input.imagePullSecrets }
      : {}),
    volumes,
    containers: [
      {
        name: "sandbox",
        image: input.dockerImage,
        imagePullPolicy: resolveImagePullPolicy(input.dockerImage),
        env,
        ports: [
          {
            name: MCP_PORT_NAME,
            containerPort: SANDBOX_MCP_PORT,
            protocol: "TCP",
          },
          {
            name: TTY_PORT_NAME,
            containerPort: SANDBOX_TTY_PORT,
            protocol: "TCP",
          },
        ],
        volumeMounts,
        resources,
        securityContext: containerSecurityContext,
        livenessProbe: {
          tcpSocket: { port: SANDBOX_MCP_PORT as unknown as k8s.IntOrString },
          initialDelaySeconds: 15,
          periodSeconds: 30,
          timeoutSeconds: 5,
          failureThreshold: 3,
        },
      },
    ],
  };

  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: { name: names.job, labels },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: 0,
      activeDeadlineSeconds: input.idleHardCapHours * SECONDS_PER_HOUR,
      template: {
        metadata: { labels },
        spec: podSpec,
      },
    },
  };
}

function mergeResources(
  override: GenerateSandboxSpecInput["resources"],
): k8s.V1ResourceRequirements {
  return {
    requests: {
      memory: override?.requests?.memory ?? DEFAULT_RESOURCE_REQUEST_MEMORY,
      cpu: override?.requests?.cpu ?? DEFAULT_RESOURCE_REQUEST_CPU,
    },
    limits: {
      memory: override?.limits?.memory ?? DEFAULT_RESOURCE_LIMIT_MEMORY,
      cpu: override?.limits?.cpu ?? DEFAULT_RESOURCE_LIMIT_CPU,
    },
  };
}

function resolveImagePullPolicy(
  image: string,
): k8s.V1Container["imagePullPolicy"] {
  // Mirror the existing convention in K8sDeployment: local images without a
  // registry/domain segment are loaded by the node and must use Never. Remote
  // images let K8s pick the policy based on the tag.
  return image.includes("/") || image.includes(".") ? undefined : "Never";
}

/**
 * Sanitize values only. K8s label keys may carry a DNS-style prefix segment
 * (e.g. `archestra.ai/runtime`) which the shared `sanitizeMetadataLabels`
 * helper strips because it was authored for unprefixed keys. The sandbox
 * profile relies on prefixed keys, so we keep keys verbatim and only RFC-1123
 * the values.
 */
function sanitizeLabelValuesOnly(
  labels: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels)) {
    out[key] = sanitizeLabelValue(value);
  }
  return out;
}
