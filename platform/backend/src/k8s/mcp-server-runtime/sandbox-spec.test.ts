import { describe, expect, test } from "@/test";
import {
  constructSandboxNames,
  type GenerateSandboxSpecInput,
  generateSandboxSpec,
  SANDBOX_MCP_PORT,
  SANDBOX_TTY_PORT,
} from "./sandbox-spec";

const SANDBOX_SERVICE_ACCOUNT_NAME = "mcp-sandbox-no-rbac";

const baseInput: GenerateSandboxSpecInput = {
  conversationId: "11111111-1111-1111-1111-111111111111",
  mcpServerId: "22222222-2222-2222-2222-222222222222",
  mcpServerName: "code-sandbox",
  dockerImage: "registry.example.com/archestra/mcp-server-sandbox:1.0.0",
  bearerToken: "test-bearer-token",
  idleTimeoutSeconds: 900,
  idleHardCapHours: 24,
  pvcSize: "10Gi",
  serviceType: "ClusterIP",
};

describe("generateSandboxSpec", () => {
  test("constructs stable, conversation-scoped names for all four resources", () => {
    const names = constructSandboxNames("abc-123");
    expect(names).toEqual({
      job: "sandbox-job-abc-123",
      service: "sandbox-svc-abc-123",
      pvc: "sandbox-pvc-abc-123",
      secret: "sandbox-secret-abc-123",
    });
  });

  test("emits Job, Service, PVC, and Secret bound to the conversation", () => {
    const spec = generateSandboxSpec(baseInput);

    expect(spec.job.kind).toBe("Job");
    expect(spec.job.apiVersion).toBe("batch/v1");
    expect(spec.service.kind).toBe("Service");
    expect(spec.pvc.kind).toBe("PersistentVolumeClaim");
    expect(spec.secret.kind).toBe("Secret");

    expect(spec.names.pvc).toContain(baseInput.conversationId);
    expect(spec.names.secret).toContain(baseInput.conversationId);
    expect(spec.names.job).toContain(baseInput.conversationId);
    expect(spec.names.service).toContain(baseInput.conversationId);
  });

  test("Job carries Pod Security Admission posture matching R8", () => {
    const spec = generateSandboxSpec(baseInput);
    const podSpec = spec.job.spec?.template.spec;
    if (!podSpec) throw new Error("Job pod spec missing");

    expect(podSpec.restartPolicy).toBe("Never");
    expect(podSpec.serviceAccountName).toBe(SANDBOX_SERVICE_ACCOUNT_NAME);
    expect(podSpec.automountServiceAccountToken).toBe(false);

    expect(podSpec.securityContext).toMatchObject({
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      fsGroup: 1000,
      fsGroupChangePolicy: "OnRootMismatch",
      seccompProfile: { type: "RuntimeDefault" },
      appArmorProfile: { type: "RuntimeDefault" },
    });

    const container = podSpec.containers[0];
    if (!container) throw new Error("Sandbox container missing");
    expect(container.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
      readOnlyRootFilesystem: true,
    });
  });

  test("Job exposes both MCP and ttyd container ports", () => {
    const spec = generateSandboxSpec(baseInput);
    const ports = spec.job.spec?.template.spec?.containers[0]?.ports ?? [];
    expect(ports).toEqual([
      { name: "mcp", containerPort: SANDBOX_MCP_PORT, protocol: "TCP" },
      { name: "tty", containerPort: SANDBOX_TTY_PORT, protocol: "TCP" },
    ]);
  });

  test("Job mounts tmp tmpfs, var-run tmpfs, workspace PVC, and bearer-token secret", () => {
    const spec = generateSandboxSpec(baseInput);
    const podSpec = spec.job.spec?.template.spec;
    if (!podSpec) throw new Error("Job pod spec missing");

    expect(podSpec.volumes).toEqual([
      { name: "tmp", emptyDir: {} },
      { name: "var-run", emptyDir: {} },
      {
        name: "workspace",
        persistentVolumeClaim: { claimName: spec.names.pvc },
      },
      {
        name: "bearer-token",
        secret: {
          secretName: spec.names.secret,
          items: [{ key: "bearer-token", path: "bearer-token" }],
        },
      },
    ]);

    const mounts = podSpec.containers[0]?.volumeMounts ?? [];
    expect(mounts).toEqual([
      { name: "tmp", mountPath: "/tmp" },
      { name: "var-run", mountPath: "/var/run" },
      { name: "workspace", mountPath: "/workspace" },
      { name: "bearer-token", mountPath: "/secrets", readOnly: true },
    ]);
  });

  test("Job applies the configured idle timeout and hard-cap deadline", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      idleTimeoutSeconds: 600,
      idleHardCapHours: 12,
    });

    expect(spec.job.spec?.activeDeadlineSeconds).toBe(12 * 3600);
    expect(spec.job.spec?.backoffLimit).toBe(0);
    expect(spec.job.spec?.ttlSecondsAfterFinished).toBe(0);

    const env = spec.job.spec?.template.spec?.containers[0]?.env ?? [];
    expect(env).toContainEqual({
      name: "IDLE_TIMEOUT_SECONDS",
      value: "600",
    });
    expect(env).toContainEqual({
      name: "ARCHESTRA_SANDBOX_BEARER_TOKEN_PATH",
      value: "/secrets/bearer-token",
    });
  });

  test("Service exposes mcp+tty ports and selects on conversationId+runtime", () => {
    const spec = generateSandboxSpec(baseInput);
    const ports = spec.service.spec?.ports ?? [];
    expect(ports.map((p) => p.name)).toEqual(["mcp", "tty"]);
    expect(ports.find((p) => p.name === "mcp")?.port).toBe(SANDBOX_MCP_PORT);
    expect(ports.find((p) => p.name === "tty")?.port).toBe(SANDBOX_TTY_PORT);

    const selector = spec.service.spec?.selector ?? {};
    expect(selector.app).toBe("mcp-server");
    expect(selector["archestra.ai/runtime"]).toBe("sandbox");
    expect(selector["archestra.ai/conversation-id"]).toBeDefined();
    // Selector must NOT include mcp-server-id — sandboxes are conversation-scoped
    // and a single mcp_server may have many concurrent sandbox pods.
    expect(selector["mcp-server-id"]).toBeUndefined();
  });

  test("NodePort mode applies explicit per-port NodePorts when supplied", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      serviceType: "NodePort",
      mcpNodePort: 31080,
      ttyNodePort: 31681,
    });
    const ports = spec.service.spec?.ports ?? [];
    expect(spec.service.spec?.type).toBe("NodePort");
    expect(ports.find((p) => p.name === "mcp")?.nodePort).toBe(31080);
    expect(ports.find((p) => p.name === "tty")?.nodePort).toBe(31681);
  });

  test("ClusterIP mode never carries nodePort fields even if supplied", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      mcpNodePort: 31080,
      ttyNodePort: 31681,
    });
    expect(spec.service.spec?.type).toBe("ClusterIP");
    for (const port of spec.service.spec?.ports ?? []) {
      expect(port.nodePort).toBeUndefined();
    }
  });

  test("PVC requests the configured size and omits storageClassName when unset", () => {
    const spec = generateSandboxSpec({ ...baseInput, pvcSize: "20Gi" });
    expect(spec.pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(spec.pvc.spec?.resources?.requests?.storage).toBe("20Gi");
    expect(spec.pvc.spec?.storageClassName).toBeUndefined();
  });

  test("PVC carries the configured storageClassName when supplied", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      pvcStorageClassName: "wait-for-first-consumer",
    });
    expect(spec.pvc.spec?.storageClassName).toBe("wait-for-first-consumer");
  });

  test("Secret base64-encodes the runtime bearer token under bearer-token key", () => {
    const spec = generateSandboxSpec(baseInput);
    expect(spec.secret.type).toBe("Opaque");
    expect(spec.secret.data?.["bearer-token"]).toBe(
      Buffer.from(baseInput.bearerToken).toString("base64"),
    );
  });

  test("rejects invalid input early with descriptive errors", () => {
    expect(() =>
      generateSandboxSpec({ ...baseInput, conversationId: "" }),
    ).toThrow(/conversationId/);
    expect(() =>
      generateSandboxSpec({ ...baseInput, idleTimeoutSeconds: 0 }),
    ).toThrow(/idleTimeoutSeconds/);
    expect(() =>
      generateSandboxSpec({ ...baseInput, idleHardCapHours: 0 }),
    ).toThrow(/idleHardCapHours/);
    expect(() => generateSandboxSpec({ ...baseInput, pvcSize: "" })).toThrow(
      /pvcSize/,
    );
    expect(() =>
      generateSandboxSpec({ ...baseInput, bearerToken: "" }),
    ).toThrow(/bearerToken/);
  });

  test("local image (no slash, no dot) gets Never imagePullPolicy", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      dockerImage: "mcp-server-sandbox:dev",
    });
    expect(spec.job.spec?.template.spec?.containers[0]?.imagePullPolicy).toBe(
      "Never",
    );
  });

  test("registry image gets default imagePullPolicy (undefined)", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      dockerImage: "registry.example.com/sandbox:1.0.0",
    });
    expect(
      spec.job.spec?.template.spec?.containers[0]?.imagePullPolicy,
    ).toBeUndefined();
  });

  test("nodeSelector and tolerations propagate when provided", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      nodeSelector: { "archestra.ai/sandbox-pool": "true" },
      tolerations: [{ key: "sandbox", operator: "Exists" }],
    });
    expect(spec.job.spec?.template.spec?.nodeSelector).toEqual({
      "archestra.ai/sandbox-pool": "true",
    });
    expect(spec.job.spec?.template.spec?.tolerations).toEqual([
      { key: "sandbox", operator: "Exists" },
    ]);
  });

  test("nodeSelector and tolerations are omitted when unset", () => {
    const spec = generateSandboxSpec(baseInput);
    expect(spec.job.spec?.template.spec?.nodeSelector).toBeUndefined();
    expect(spec.job.spec?.template.spec?.tolerations).toBeUndefined();
  });

  test("snapshot covers the full Job spec for the sandbox profile", () => {
    const spec = generateSandboxSpec({
      ...baseInput,
      conversationId: "conv-123",
      mcpServerId: "srv-456",
      mcpServerName: "code-sandbox",
      dockerImage: "registry.example.com/sandbox:1.0.0",
      bearerToken: "deterministic-token",
    });
    expect(spec.job).toMatchSnapshot();
    expect(spec.service).toMatchSnapshot();
    expect(spec.pvc).toMatchSnapshot();
    expect(spec.secret).toMatchSnapshot();
  });
});
