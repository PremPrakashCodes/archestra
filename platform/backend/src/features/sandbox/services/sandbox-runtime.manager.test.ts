import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import { ConversationSandboxModel } from "@/models";
import { describe, expect, test } from "@/test";
import {
  SandboxRuntimeManager as ManagerClass,
  type SandboxRuntimeManager,
} from "./sandbox-runtime.manager";
import { SandboxRuntimeError } from "./sandbox-state.types";

interface PodSimulation {
  phase: "Pending" | "Running" | "Failed";
  message?: string;
  podName?: string;
}

/**
 * Builds an in-memory K8s mock that records calls and lets each test program
 * Pod-status sequences without standing up a real cluster.
 */
function buildK8sMock(initial: { podBehaviour?: PodSimulation[] } = {}) {
  const calls = {
    secretCreate: vi.fn().mockResolvedValue(undefined),
    secretReplace: vi.fn(),
    secretDelete: vi.fn().mockResolvedValue(undefined),
    pvcCreate: vi.fn().mockResolvedValue(undefined),
    pvcRead: vi.fn(),
    pvcDelete: vi.fn().mockResolvedValue(undefined),
    serviceCreate: vi.fn().mockResolvedValue(undefined),
    serviceRead: vi.fn(),
    serviceDelete: vi.fn().mockResolvedValue(undefined),
    jobCreate: vi.fn().mockResolvedValue(undefined),
    jobRead: vi.fn(),
    jobDelete: vi.fn().mockResolvedValue(undefined),
    listPods: vi.fn(),
  };

  // Default: surface 404 for the pre-create reads so the manager creates fresh.
  const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
  calls.secretReplace.mockRejectedValue(notFound);
  calls.pvcRead.mockRejectedValue(notFound);
  calls.serviceRead.mockRejectedValue(notFound);

  const podBehaviour = [...(initial.podBehaviour ?? [])];
  let lastObserved: PodSimulation | undefined;
  calls.listPods.mockImplementation(() => {
    // Once the scripted sequence is exhausted, repeat the last entry. This
    // matches a real cluster: a pod stays in its current phase until the
    // controller transitions it. Tests use this to keep returning "Pending"
    // for timeout coverage.
    const fromQueue = podBehaviour.shift();
    if (fromQueue) {
      lastObserved = fromQueue;
    }
    const next: PodSimulation = fromQueue ??
      lastObserved ?? {
        phase: "Running",
        podName: "sandbox-pod-default",
      };
    return Promise.resolve({
      items: [
        {
          metadata: { name: next.podName ?? "sandbox-pod-default" },
          status: { phase: next.phase, message: next.message },
        },
      ],
    });
  });

  // Default jobRead returns a job (used by getState lazy-detect tests when overridden).
  calls.jobRead.mockResolvedValue({ metadata: { name: "sandbox-job" } });

  const coreApi = {
    createNamespacedSecret: calls.secretCreate,
    replaceNamespacedSecret: calls.secretReplace,
    deleteNamespacedSecret: calls.secretDelete,
    createNamespacedPersistentVolumeClaim: calls.pvcCreate,
    readNamespacedPersistentVolumeClaim: calls.pvcRead,
    deleteNamespacedPersistentVolumeClaim: calls.pvcDelete,
    createNamespacedService: calls.serviceCreate,
    readNamespacedService: calls.serviceRead,
    deleteNamespacedService: calls.serviceDelete,
    listNamespacedPod: calls.listPods,
  } as unknown as k8s.CoreV1Api;

  const batchApi = {
    createNamespacedJob: calls.jobCreate,
    readNamespacedJob: calls.jobRead,
    deleteNamespacedJob: calls.jobDelete,
  } as unknown as k8s.BatchV1Api;

  return { coreApi, batchApi, calls };
}

// Vitest fixture function types are not exported from src/test/fixtures.ts;
// rather than re-deriving them, accept a loose helper bag and rely on the
// per-test destructuring to provide the right shape.
// biome-ignore lint/suspicious/noExplicitAny: see comment above
type FixtureFn = (...args: any[]) => Promise<any>;

async function buildManagerWithCatalog({
  makeUser,
  makeOrganization,
  makeAgent,
  makeInternalMcpCatalog,
  makeMcpServer,
  makeConversation,
  podBehaviour,
}: {
  makeUser: FixtureFn;
  makeOrganization: FixtureFn;
  makeAgent: FixtureFn;
  makeInternalMcpCatalog: FixtureFn;
  makeMcpServer: FixtureFn;
  makeConversation: FixtureFn;
  podBehaviour?: PodSimulation[];
}) {
  const user = await makeUser();
  const org = await makeOrganization();
  const agent = await makeAgent({ organizationId: org.id, authorId: user.id });
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: {
      command: "/sandbox-entrypoint.sh",
      dockerImage: "registry.example.com/sandbox:1.0.0",
      runtimeProfile: "sandbox",
      sandbox: {
        idleTimeoutMinutes: 15,
        pvcSizeGiB: 10,
        ttyPort: 7681,
      },
    },
  });
  const mcpServer = await makeMcpServer({ catalogId: catalog.id });
  const conversation = await makeConversation(agent.id, {
    userId: user.id,
    organizationId: org.id,
  });

  const k8sMock = buildK8sMock({ podBehaviour });
  const manager: SandboxRuntimeManager = new ManagerClass({
    loadClients: () => ({
      clients: { coreApi: k8sMock.coreApi, batchApi: k8sMock.batchApi },
      namespace: "test-namespace",
    }),
    readiness: { pollIntervalMs: 5, timeoutMs: 200 },
  });

  return { manager, k8sMock, conversation, mcpServer };
}

describe("SandboxRuntimeManager.provisionForConversation", () => {
  test("creates Secret, PVC, Service, Job in order and persists running state", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [
          { phase: "Pending" },
          { phase: "Running", podName: "sandbox-pod-1" },
        ],
      });

    const result = await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    expect(result.state).toBe("running");
    expect(result.podName).toBe("sandbox-pod-1");
    expect(result.pvcName).toBe(`sandbox-pvc-${conversation.id}`);
    expect(result.secretName).toBe(`sandbox-secret-${conversation.id}`);

    expect(k8sMock.calls.secretCreate).toHaveBeenCalledTimes(1);
    expect(k8sMock.calls.pvcCreate).toHaveBeenCalledTimes(1);
    expect(k8sMock.calls.serviceCreate).toHaveBeenCalledTimes(1);
    expect(k8sMock.calls.jobCreate).toHaveBeenCalledTimes(1);

    const secretCall = k8sMock.calls.secretCreate.mock.invocationCallOrder[0];
    const pvcCall = k8sMock.calls.pvcCreate.mock.invocationCallOrder[0];
    const serviceCall = k8sMock.calls.serviceCreate.mock.invocationCallOrder[0];
    const jobCall = k8sMock.calls.jobCreate.mock.invocationCallOrder[0];
    expect(secretCall).toBeLessThan(pvcCall);
    expect(pvcCall).toBeLessThan(serviceCall);
    expect(serviceCall).toBeLessThan(jobCall);
  });

  test("calling twice while in flight returns the same promise (no duplicate K8s calls)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [
          { phase: "Pending" },
          { phase: "Running", podName: "sandbox-pod-1" },
        ],
      });

    const first = manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });
    const second = manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });
    const [a, b] = await Promise.all([first, second]);
    expect(a.podName).toBe(b.podName);
    expect(k8sMock.calls.jobCreate).toHaveBeenCalledTimes(1);
  });

  test("returns immediately when the row is already running (no K8s create calls)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
      });

    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    k8sMock.calls.secretCreate.mockClear();
    k8sMock.calls.pvcCreate.mockClear();
    k8sMock.calls.serviceCreate.mockClear();
    k8sMock.calls.jobCreate.mockClear();

    const second = await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });
    expect(second.state).toBe("running");
    expect(k8sMock.calls.jobCreate).not.toHaveBeenCalled();
  });

  test("provisioning timeout transitions row to error with provisioningError", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, conversation, mcpServer } = await buildManagerWithCatalog({
      makeUser,
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeConversation,
      podBehaviour: [
        { phase: "Pending" },
        { phase: "Pending" },
        { phase: "Pending" },
      ],
    });

    await expect(
      manager.provisionForConversation({
        conversationId: conversation.id,
        mcpServerId: mcpServer.id,
      }),
    ).rejects.toThrow(SandboxRuntimeError);

    const row = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    expect(row?.state).toBe("error");
    expect(row?.provisioningError).toMatch(/Timed out/i);
  });

  test("rejects when the MCP server is not configured with runtimeProfile=sandbox", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
    });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        command: "node",
        dockerImage: "registry.example.com/non-sandbox:1.0.0",
        // No runtimeProfile -> defaults to "mcp"
      },
    });
    const server = await makeMcpServer({ catalogId: catalog.id });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });

    const k8sMock = buildK8sMock();
    const manager = new ManagerClass({
      loadClients: () => ({
        clients: { coreApi: k8sMock.coreApi, batchApi: k8sMock.batchApi },
        namespace: "test-namespace",
      }),
      readiness: { pollIntervalMs: 5, timeoutMs: 200 },
    });

    await expect(
      manager.provisionForConversation({
        conversationId: conv.id,
        mcpServerId: server.id,
      }),
    ).rejects.toThrow(/runtimeProfile=sandbox/);
    expect(k8sMock.calls.jobCreate).not.toHaveBeenCalled();
  });

  test("throws SANDBOX_RUNTIME_UNAVAILABLE when K8s clients cannot be loaded", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const user = await makeUser();
    const org = await makeOrganization();
    const agent = await makeAgent({
      organizationId: org.id,
      authorId: user.id,
    });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      localConfig: {
        command: "/sandbox-entrypoint.sh",
        dockerImage: "registry.example.com/sandbox:1.0.0",
        runtimeProfile: "sandbox",
      },
    });
    const server = await makeMcpServer({ catalogId: catalog.id });
    const conv = await makeConversation(agent.id, {
      userId: user.id,
      organizationId: org.id,
    });

    const manager = new ManagerClass({
      loadClients: () => null,
      readiness: { pollIntervalMs: 5, timeoutMs: 50 },
    });

    await expect(
      manager.provisionForConversation({
        conversationId: conv.id,
        mcpServerId: server.id,
      }),
    ).rejects.toMatchObject({
      code: "SANDBOX_RUNTIME_UNAVAILABLE",
    });
  });
});

describe("SandboxRuntimeManager.markActivity", () => {
  test("bumps lastActivityAt on the row", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, conversation, mcpServer } = await buildManagerWithCatalog({
      makeUser,
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeConversation,
      podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
    });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    const before = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    await new Promise((r) => setTimeout(r, 10));
    await manager.markActivity({ conversationId: conversation.id });
    const after = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    expect(after?.lastActivityAt?.getTime()).toBeGreaterThan(
      before?.lastActivityAt?.getTime() ?? 0,
    );
  });
});

describe("SandboxRuntimeManager.destroyForConversation", () => {
  test("deletes Job (Foreground), Service, PVC, Secret in order, then the row", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
      });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    await manager.destroyForConversation({ conversationId: conversation.id });

    expect(k8sMock.calls.jobDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        propagationPolicy: "Foreground",
        name: `sandbox-job-${conversation.id}`,
      }),
    );
    expect(k8sMock.calls.serviceDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: `sandbox-svc-${conversation.id}` }),
    );
    expect(k8sMock.calls.pvcDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: `sandbox-pvc-${conversation.id}` }),
    );
    expect(k8sMock.calls.secretDelete).toHaveBeenCalledWith(
      expect.objectContaining({ name: `sandbox-secret-${conversation.id}` }),
    );

    const jobOrder = k8sMock.calls.jobDelete.mock.invocationCallOrder[0];
    const svcOrder = k8sMock.calls.serviceDelete.mock.invocationCallOrder[0];
    const pvcOrder = k8sMock.calls.pvcDelete.mock.invocationCallOrder[0];
    const secOrder = k8sMock.calls.secretDelete.mock.invocationCallOrder[0];
    expect(jobOrder).toBeLessThan(svcOrder);
    expect(svcOrder).toBeLessThan(pvcOrder);
    expect(pvcOrder).toBeLessThan(secOrder);

    const row = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    expect(row).toBeNull();
  });

  test("logs and continues when K8s delete returns 404 (idempotent teardown)", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
      });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    k8sMock.calls.jobDelete.mockRejectedValueOnce(notFound);
    k8sMock.calls.serviceDelete.mockRejectedValueOnce(notFound);
    k8sMock.calls.pvcDelete.mockRejectedValueOnce(notFound);
    k8sMock.calls.secretDelete.mockRejectedValueOnce(notFound);

    await expect(
      manager.destroyForConversation({ conversationId: conversation.id }),
    ).resolves.toBeUndefined();

    const row = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    expect(row).toBeNull();
  });
});

describe("SandboxRuntimeManager.getState", () => {
  test("returns null when no row exists", async () => {
    const k8sMock = buildK8sMock();
    const manager = new ManagerClass({
      loadClients: () => ({
        clients: { coreApi: k8sMock.coreApi, batchApi: k8sMock.batchApi },
        namespace: "test-namespace",
      }),
    });
    const state = await manager.getState({
      conversationId: "00000000-0000-0000-0000-000000000000",
    });
    expect(state).toBeNull();
  });

  test("transitions running → idle-suspended when the K8s Job is gone", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
      });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    k8sMock.calls.jobRead.mockRejectedValueOnce(notFound);

    const state = await manager.getState({ conversationId: conversation.id });
    expect(state?.state).toBe("idle-suspended");

    const row = await ConversationSandboxModel.findByConversationId(
      conversation.id,
    );
    expect(row?.state).toBe("idle-suspended");
  });
});

describe("SandboxRuntimeManager.resumeIfSuspended", () => {
  test("re-provisions a suspended sandbox without rejection", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, k8sMock, conversation, mcpServer } =
      await buildManagerWithCatalog({
        makeUser,
        makeOrganization,
        makeAgent,
        makeInternalMcpCatalog,
        makeMcpServer,
        makeConversation,
        podBehaviour: [
          { phase: "Running", podName: "sandbox-pod-1" },
          { phase: "Running", podName: "sandbox-pod-2" },
        ],
      });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });

    await ConversationSandboxModel.update(conversation.id, {
      state: "idle-suspended",
    });

    const result = await manager.resumeIfSuspended({
      conversationId: conversation.id,
    });
    expect(result.state).toBe("running");
    expect(result.podName).toBe("sandbox-pod-2");
    expect(k8sMock.calls.jobCreate).toHaveBeenCalledTimes(2);
  });

  test("rejects when the row is in error state", async ({
    makeUser,
    makeOrganization,
    makeAgent,
    makeInternalMcpCatalog,
    makeMcpServer,
    makeConversation,
  }) => {
    const { manager, conversation, mcpServer } = await buildManagerWithCatalog({
      makeUser,
      makeOrganization,
      makeAgent,
      makeInternalMcpCatalog,
      makeMcpServer,
      makeConversation,
      podBehaviour: [{ phase: "Running", podName: "sandbox-pod-1" }],
    });
    await manager.provisionForConversation({
      conversationId: conversation.id,
      mcpServerId: mcpServer.id,
    });
    await ConversationSandboxModel.update(conversation.id, {
      state: "error",
      provisioningError: "boom",
    });

    await expect(
      manager.resumeIfSuspended({ conversationId: conversation.id }),
    ).rejects.toMatchObject({ code: "SANDBOX_PROVISIONING_FAILED" });
  });
});
