import { randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import multipart from "@fastify/multipart";
import { RouteId } from "@shared";
import type { FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { WebSocket } from "ws";
import { z } from "zod";

import config from "@/config";
import { sandboxFeature } from "@/features/sandbox/services/sandbox.feature";
import logger from "@/logging";
import { ConversationModel } from "@/models";
import { ApiError, constructResponseSchema } from "@/types";

const ConversationParamsSchema = z.object({
  conversationId: z.string().uuid(),
});

const UploadResponseSchema = z.object({
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  workspacePath: z.string(),
});

const SHA256_REGEX = /\b([0-9a-f]{64})\b/;
const SAFE_FILENAME_REGEX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

/**
 * Direct (LLM-bypassing) file upload into a per-conversation sandbox pod's
 * `/workspace` volume. Streams the multipart file body via `Exec.exec` into
 * an in-pod `sh -c 'cat > tmp && sha256sum && mv'` pipeline so the request
 * size is bounded by the configured cap, never the backend's process memory.
 */
const sandboxRoutes: FastifyPluginAsyncZod = async (fastify) => {
  const maxBytes = config.orchestrator.sandbox.fileUploadMaxMiB * 1024 * 1024;

  await fastify.register(multipart, {
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 0,
    },
  });

  fastify.post(
    "/api/conversations/:conversationId/sandbox/upload",
    {
      schema: {
        operationId: RouteId.UploadSandboxFile,
        tags: ["Sandbox"],
        description:
          "Upload a single file directly into a conversation-scoped sandbox pod's /workspace volume. Bypasses the LLM (no token cost).",
        params: ConversationParamsSchema,
        consumes: ["multipart/form-data"],
        response: constructResponseSchema(UploadResponseSchema),
      },
    },
    async (request, reply) => {
      const { conversationId } = ConversationParamsSchema.parse(request.params);

      if (!sandboxFeature.isEnabled()) {
        throw new ApiError(404, "Sandbox feature is disabled");
      }

      await assertConversationOwnership(request, conversationId);

      const state = await ensureSandboxRunning(conversationId);

      if (!request.isMultipart()) {
        throw new ApiError(400, "Expected multipart/form-data");
      }

      const data = await request.file().catch((error: unknown) => {
        logger.warn(
          { err: error, conversationId },
          "Failed to read multipart file from sandbox upload",
        );
        throw new ApiError(400, "Could not parse uploaded file");
      });
      if (!data) {
        throw new ApiError(400, "No file part in upload");
      }

      const safeFilename = sanitizeFilename(data.filename);

      const transfer = await streamFileIntoSandbox({
        conversationId,
        podName: state.podName,
        filename: safeFilename,
        body: data.file,
        maxBytes,
      });

      if (data.file.truncated) {
        throw new ApiError(
          413,
          `File exceeds the ${config.orchestrator.sandbox.fileUploadMaxMiB} MiB upload limit`,
        );
      }

      // Bump activity so the in-pod idle daemon does not suspend the sandbox
      // mid-conversation just because the agent wasn't the one driving the
      // upload (purely user-initiated transfers should still keep it alive).
      void sandboxFeature
        .markActivity({ conversationId })
        .catch((err: unknown) => {
          logger.warn(
            { err, conversationId },
            "markActivity after sandbox upload failed (non-fatal)",
          );
        });

      return reply.send({
        filename: safeFilename,
        sizeBytes: transfer.sizeBytes,
        sha256: transfer.sha256,
        workspacePath: `/workspace/${safeFilename}`,
      });
    },
  );
};

export default sandboxRoutes;

async function assertConversationOwnership(
  request: FastifyRequest,
  conversationId: string,
): Promise<void> {
  const agentId = await ConversationModel.getAgentIdForUser(
    conversationId,
    request.user.id,
    request.organizationId,
  );
  if (!agentId) {
    throw new ApiError(404, "Conversation not found");
  }
}

async function ensureSandboxRunning(
  conversationId: string,
): Promise<{ podName: string }> {
  let state = await sandboxFeature.getState({ conversationId });
  if (!state) {
    throw new ApiError(409, "No sandbox provisioned for this conversation");
  }

  if (state.state === "idle-suspended") {
    try {
      await sandboxFeature.resumeIfSuspended({ conversationId });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Sandbox resume failed";
      throw new ApiError(409, `Sandbox not ready: ${message}`);
    }
    state = await sandboxFeature.getState({ conversationId });
  }

  if (!state) {
    throw new ApiError(409, "Sandbox not ready");
  }
  if (state.state === "error") {
    throw new ApiError(
      409,
      `Sandbox in error state: ${state.provisioningError ?? "unknown"}`,
    );
  }
  if (state.state !== "running" || !state.podName) {
    throw new ApiError(409, `Sandbox not ready (state: ${state.state})`);
  }

  return { podName: state.podName };
}

function sanitizeFilename(raw?: string): string {
  if (!raw) {
    throw new ApiError(400, "Invalid filename: missing");
  }
  // Reject embedded NULs explicitly — Node strings preserve them silently.
  if (raw.includes("\0")) {
    throw new ApiError(400, "Invalid filename: contains null byte");
  }
  // Reject anything that even smells of path traversal: clients sending
  // `..`, slashes, or backslashes get refused before the in-pod path guard
  // ever sees the value. Defense in depth on top of U6's `realpath` check.
  if (
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.startsWith(".") ||
    raw.includes("..")
  ) {
    throw new ApiError(400, "Invalid filename: path traversal not allowed");
  }
  if (!SAFE_FILENAME_REGEX.test(raw)) {
    throw new ApiError(
      400,
      "Invalid filename: must match [A-Za-z0-9][A-Za-z0-9._-]* and be ≤255 chars",
    );
  }
  return raw;
}

async function streamFileIntoSandbox(params: {
  conversationId: string;
  podName: string;
  filename: string;
  body: Readable;
  maxBytes: number;
}): Promise<{ sizeBytes: number; sha256: string }> {
  const runtime = sandboxFeature.getRuntime();
  if (!runtime) {
    throw new ApiError(503, "Sandbox K8s runtime is unavailable");
  }
  const namespace = runtime.namespace;
  const exec = runtime.clients.exec;
  if (!exec) {
    throw new ApiError(503, "Sandbox K8s exec client is unavailable");
  }

  // Per-upload temp basename keeps concurrent uploads inside the same pod from
  // colliding even though tmpfs is shared across all in-pod processes.
  const tmpId = randomUUID();
  const tmpPath = `/tmp/sandbox-upload-${tmpId}`;

  // Single-quoted shell strings are safe because `sanitizeFilename` rejects
  // anything outside `[A-Za-z0-9._-]`. We still wrap in single quotes as a
  // defense-in-depth layer.
  const command = [
    "/bin/sh",
    "-c",
    [
      "set -eu",
      `TMP="${tmpPath}"`,
      `DST="/workspace/${params.filename}"`,
      'trap \'rm -f "$TMP" "$TMP.sha"\' EXIT',
      'cat > "$TMP"',
      'SHA=$(sha256sum "$TMP" | cut -d" " -f1)',
      'BYTES=$(wc -c < "$TMP" | tr -d " ")',
      'mv "$TMP" "$DST"',
      'printf "ARCHESTRA_UPLOAD_RESULT sha=%s bytes=%s\\n" "$SHA" "$BYTES"',
    ].join("\n"),
  ];

  const stdoutBuf: Buffer[] = [];
  const stderrBuf: Buffer[] = [];
  const stdoutSink = new PassThrough();
  const stderrSink = new PassThrough();
  stdoutSink.on("data", (chunk: Buffer) => stdoutBuf.push(chunk));
  stderrSink.on("data", (chunk: Buffer) => stderrBuf.push(chunk));

  const k8sWs = (await exec.exec(
    namespace,
    params.podName,
    "sandbox",
    command,
    stdoutSink,
    stderrSink,
    params.body,
    false,
  )) as unknown as WebSocket;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      k8sWs.removeAllListeners?.("close");
      k8sWs.removeAllListeners?.("error");
    };
    k8sWs.on("close", () => {
      cleanup();
      resolve();
    });
    k8sWs.on("error", (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  const stdout = Buffer.concat(stdoutBuf).toString("utf-8");
  const stderr = Buffer.concat(stderrBuf).toString("utf-8");

  const resultLine = stdout
    .split("\n")
    .reverse()
    .find((line) => line.startsWith("ARCHESTRA_UPLOAD_RESULT"));
  if (!resultLine) {
    logger.error(
      {
        conversationId: params.conversationId,
        stdout,
        stderr,
      },
      "Sandbox upload pipeline produced no result marker",
    );
    throw new ApiError(502, "Sandbox upload failed (no result marker)");
  }

  const shaMatch = resultLine.match(SHA256_REGEX);
  const bytesMatch = resultLine.match(/bytes=(\d+)/);
  if (!shaMatch || !bytesMatch) {
    throw new ApiError(502, "Sandbox upload failed (could not parse result)");
  }
  const sha256 = shaMatch[1] as string;
  const sizeBytes = Number.parseInt(bytesMatch[1] as string, 10);
  if (!Number.isFinite(sizeBytes)) {
    throw new ApiError(502, "Sandbox upload failed (invalid byte count)");
  }

  return { sha256, sizeBytes };
}
