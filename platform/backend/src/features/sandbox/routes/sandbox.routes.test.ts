import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import type * as k8s from "@kubernetes/client-node";
import { vi } from "vitest";
import { sandboxFeature } from "@/features/sandbox/services/sandbox.feature";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability", () => ({
  initializeObservabilityMetrics: vi.fn(),
  metrics: {
    llm: { initializeMetrics: vi.fn() },
    mcp: { initializeMcpMetrics: vi.fn() },
    agentExecution: { initializeAgentExecutionMetrics: vi.fn() },
  },
}));

class FakeWs extends EventEmitter {
  finish() {
    queueMicrotask(() => this.emit("close"));
  }
  fail(err: unknown) {
    queueMicrotask(() => this.emit("error", err));
  }
}

interface ExecCall {
  namespace: string;
  podName: string;
  container: string;
  command: string[];
  stdoutData: Buffer;
  stderrData: Buffer;
  uploadedBody: Buffer;
}

interface ExecOverrides {
  /** When set, exec rejects upfront (e.g. pod-not-found from kubelet). */
  rejectWith?: Error;
  /** When set, exec emits this on the WS instead of completing successfully. */
  errorOnExec?: Error;
  /** Override the bytes the in-pod `cat` would observe. Useful to simulate truncation. */
  bodyHook?: (uploadedBody: Buffer) => Buffer;
  /** Override what the in-pod `sh` writes to stdout (sha256 marker line). */
  stdoutOverride?: string;
}

function createFakeExec(overrides: ExecOverrides = {}): {
  exec: k8s.Exec;
  calls: ExecCall[];
} {
  const calls: ExecCall[] = [];
  const exec = {
    exec: vi.fn(
      async (
        namespace: string,
        podName: string,
        container: string,
        command: string[],
        stdout: Writable,
        _stderr: Writable,
        stdin: Readable,
        _tty: boolean,
      ) => {
        if (overrides.rejectWith) {
          throw overrides.rejectWith;
        }
        const ws = new FakeWs();
        const chunks: Buffer[] = [];

        stdin.on("data", (chunk: Buffer) => chunks.push(chunk));

        stdin.once("end", () => {
          const uploaded = overrides.bodyHook
            ? overrides.bodyHook(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const sha = createHash("sha256").update(uploaded).digest("hex");
          const stdoutLine =
            overrides.stdoutOverride ??
            `ARCHESTRA_UPLOAD_RESULT sha=${sha} bytes=${uploaded.length}\n`;

          calls.push({
            namespace,
            podName,
            container,
            command,
            stdoutData: Buffer.from(stdoutLine, "utf-8"),
            stderrData: Buffer.alloc(0),
            uploadedBody: uploaded,
          });

          stdout.write(stdoutLine);
          if (overrides.errorOnExec) {
            ws.fail(overrides.errorOnExec);
            return;
          }
          ws.finish();
        });

        return ws as unknown as ReturnType<k8s.Exec["exec"]>;
      },
    ),
  } as unknown as k8s.Exec;

  return { exec, calls };
}

const CONVERSATION_ID = crypto.randomUUID();
const OTHER_CONVO = crypto.randomUUID();

const RUNNING_STATE = {
  conversationId: CONVERSATION_ID,
  mcpServerId: "mcp-1",
  state: "running" as const,
  mcpEndpointUrl: "http://sandbox-svc:8080/mcp",
  ttyEndpointUrl: "http://sandbox-svc:7681",
  podName: "sandbox-pod-1",
  pvcName: "sandbox-pvc-1",
  secretName: "sandbox-secret-1",
  lastActivityAt: new Date(),
  idleDeadlineAt: new Date(Date.now() + 900_000),
  provisioningError: null,
};

function buildMultipartBody(filename: string, body: Buffer | string) {
  const boundary = "----archestra-test-boundary-abcdef";
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf-8") : body;
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="file"; filename="${filename}"`,
      "Content-Type: application/octet-stream",
      "",
      "",
    ].join("\r\n"),
    "utf-8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  return {
    payload: Buffer.concat([head, bodyBuf, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("POST /api/conversations/:id/sandbox/upload", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;
  let exec: k8s.Exec;
  let calls: ExecCall[];

  beforeEach(
    async ({
      makeOrganization,
      makeAdmin,
      makeMember,
      makeAgent,
      makeConversation,
    }) => {
      const org = await makeOrganization();
      organizationId = org.id;
      user = await makeAdmin();
      await makeMember(user.id, organizationId, { role: "admin" });

      const agent = await makeAgent();
      await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
        // Force the conversation id we use in the URL — fixtures default to a fresh UUID.
      });

      // The conversation we're testing against:
      await makeConversation(agent.id, {
        userId: user.id,
        organizationId,
      });

      // Re-create with the exact id our state fixture references so ownership
      // resolves through ConversationModel.getAgentIdForUser.
      const dbModule = await import("@/database");
      const db = dbModule.default;
      const { schema } = dbModule;
      await db.insert(schema.conversationsTable).values({
        id: CONVERSATION_ID,
        userId: user.id,
        organizationId,
        agentId: agent.id,
        title: "Sandbox upload test",
        selectedModel: "gpt-4o",
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      app = createFastifyInstance();
      app.addHook("onRequest", async (request) => {
        (
          request as typeof request & {
            user: User;
            organizationId: string;
          }
        ).user = user;
        (
          request as typeof request & {
            user: User;
            organizationId: string;
          }
        ).organizationId = organizationId;
      });

      const { default: sandboxRoutes } = await import("./sandbox.routes");
      await app.register(sandboxRoutes);
      await app.ready();

      const fake = createFakeExec();
      exec = fake.exec;
      calls = fake.calls;

      vi.spyOn(sandboxFeature, "isEnabled").mockReturnValue(true);
      vi.spyOn(sandboxFeature, "getState").mockResolvedValue(RUNNING_STATE);
      vi.spyOn(sandboxFeature, "markActivity").mockResolvedValue(undefined);
      vi.spyOn(sandboxFeature, "getRuntime").mockReturnValue({
        namespace: "ns",
        clients: {
          coreApi: {} as k8s.CoreV1Api,
          batchApi: {} as k8s.BatchV1Api,
          exec,
        },
      });
    },
  );

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  test("uploads a file, returns sha256 + size, and reaches the right pod", async () => {
    const fileBody = "col1,col2\nvalue1,value2\n";
    const expectedSha = createHash("sha256")
      .update(Buffer.from(fileBody, "utf-8"))
      .digest("hex");

    const { payload, contentType } = buildMultipartBody("data.csv", fileBody);

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      filename: "data.csv",
      sizeBytes: Buffer.byteLength(fileBody, "utf-8"),
      sha256: expectedSha,
      workspacePath: "/workspace/data.csv",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one exec call");
    expect(call.namespace).toBe("ns");
    expect(call.podName).toBe("sandbox-pod-1");
    expect(call.container).toBe("sandbox");
    expect(call.command[0]).toBe("/bin/sh");
    // The sh script must reference /workspace/data.csv (sanitized filename).
    expect(call.command[2]).toContain("/workspace/data.csv");
    // markActivity should be fired-and-forgotten after a successful upload.
    expect(sandboxFeature.markActivity).toHaveBeenCalledWith({
      conversationId: CONVERSATION_ID,
    });
  });

  test("rejects filenames containing .. with 400", async () => {
    // Note: many multipart parsers strip path components from filename, so a
    // raw `../etc/passwd` arrives at the route as just `passwd`. We test the
    // path-traversal-substring rule directly with a name that survives the
    // parser intact.
    const { payload, contentType } = buildMultipartBody("..hidden.txt", "evil");

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rejects hidden-dotfile filenames with 400", async () => {
    const { payload, contentType } = buildMultipartBody(".env", "secret");

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("rejects filenames with null bytes", async () => {
    const { payload, contentType } = buildMultipartBody("a\0b.txt", "x");

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(400);
    expect(calls).toHaveLength(0);
  });

  test("returns 413 when the file exceeds the configured upload limit", async () => {
    // The test config caps uploads at 16 MiB; emulate truncation by overriding
    // multipart's behaviour via a 17 MiB body.
    const oversized = Buffer.alloc(17 * 1024 * 1024, 0x61);
    const { payload, contentType } = buildMultipartBody("big.bin", oversized);

    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(413);
  });

  test("returns 404 when the conversation is not owned by the user", async () => {
    const { payload, contentType } = buildMultipartBody("data.csv", "x");
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${OTHER_CONVO}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(404);
  });

  test("returns 409 when the sandbox is in error state", async () => {
    vi.spyOn(sandboxFeature, "getState").mockResolvedValue({
      ...RUNNING_STATE,
      state: "error",
      provisioningError: "kaboom",
    });

    const { payload, contentType } = buildMultipartBody("data.csv", "x");
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });

  test("returns 404 when the sandbox feature is disabled", async () => {
    vi.spyOn(sandboxFeature, "isEnabled").mockReturnValue(false);

    const { payload, contentType } = buildMultipartBody("data.csv", "x");
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  test("returns 502 when the in-pod pipeline fails to emit the result marker", async () => {
    const fake = createFakeExec({ stdoutOverride: "no-marker\n" });
    vi.spyOn(sandboxFeature, "getRuntime").mockReturnValue({
      namespace: "ns",
      clients: {
        coreApi: {} as k8s.CoreV1Api,
        batchApi: {} as k8s.BatchV1Api,
        exec: fake.exec,
      },
    });

    const { payload, contentType } = buildMultipartBody("data.csv", "x");
    const response = await app.inject({
      method: "POST",
      url: `/api/conversations/${CONVERSATION_ID}/sandbox/upload`,
      payload,
      headers: { "content-type": contentType },
    });

    expect(response.statusCode).toBe(502);
  });
});
