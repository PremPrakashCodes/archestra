import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import { describe, expect, test } from "@/test";
import ConversationSandboxModel from "./conversation-sandbox";

async function seedSandbox({
  makeAgent,
  makeMcpServer,
  makeConversation,
  state = "provisioning" as const,
}: {
  makeAgent: () => Promise<{ id: string }>;
  makeMcpServer: () => Promise<{ id: string }>;
  makeConversation: (agentId: string) => Promise<{ id: string }>;
  state?: "provisioning" | "running" | "idle-suspended" | "stopped" | "error";
}) {
  const agent = await makeAgent();
  const conversation = await makeConversation(agent.id);
  const mcpServer = await makeMcpServer();
  const row = await ConversationSandboxModel.create({
    conversationId: conversation.id,
    mcpServerId: mcpServer.id,
    state,
    pvcName: `sandbox-pvc-${conversation.id}`,
  });
  return { agent, conversation, mcpServer, row };
}

describe("ConversationSandboxModel", () => {
  describe("create + findByConversationId", () => {
    test("returns null when no row exists", async ({
      makeAgent,
      makeConversation,
    }) => {
      const agent = await makeAgent();
      const conversation = await makeConversation(agent.id);
      const result = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(result).toBeNull();
    });

    test("create inserts row with defaults; findByConversationId returns it", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation, row } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
      });

      expect(row.conversationId).toBe(conversation.id);
      expect(row.state).toBe("provisioning");
      expect(row.podName).toBeNull();
      expect(row.lastActivityAt).toBeNull();

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found?.conversationId).toBe(conversation.id);
      expect(found?.pvcName).toBe(row.pvcName);
    });
  });

  describe("update", () => {
    test("updates state and bumps updatedAt", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation, row } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
      });
      const initialUpdatedAt = row.updatedAt.getTime();

      // Drizzle's $onUpdate gives ms-precision; ensure progression even on fast hosts.
      await new Promise((r) => setTimeout(r, 5));

      const updated = await ConversationSandboxModel.update(conversation.id, {
        state: "running",
        podName: "sandbox-pod-1",
      });

      expect(updated?.state).toBe("running");
      expect(updated?.podName).toBe("sandbox-pod-1");
      expect(updated?.updatedAt.getTime()).toBeGreaterThan(initialUpdatedAt);
    });

    test("returns null when row does not exist", async ({
      makeAgent,
      makeConversation,
    }) => {
      const agent = await makeAgent();
      const conversation = await makeConversation(agent.id);
      const result = await ConversationSandboxModel.update(conversation.id, {
        state: "running",
      });
      expect(result).toBeNull();
    });
  });

  describe("bumpLastActivity", () => {
    test("advances lastActivityAt", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "running",
      });

      const at = new Date("2026-05-01T12:00:00Z");
      await ConversationSandboxModel.bumpLastActivity(conversation.id, at);

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found?.lastActivityAt?.getTime()).toBe(at.getTime());
    });

    test("rapid repeated calls are idempotent (last write wins)", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "running",
      });

      const t1 = new Date("2026-05-01T12:00:00Z");
      const t2 = new Date("2026-05-01T12:00:01Z");
      await ConversationSandboxModel.bumpLastActivity(conversation.id, t1);
      await ConversationSandboxModel.bumpLastActivity(conversation.id, t2);

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found?.lastActivityAt?.getTime()).toBe(t2.getTime());
    });
  });

  describe("cascade deletes", () => {
    test("deleting parent conversation removes the sandbox row", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
      });

      await db
        .delete(schema.conversationsTable)
        .where(eq(schema.conversationsTable.id, conversation.id));

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found).toBeNull();
    });

    test("deleting parent mcp_server removes the sandbox row", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation, mcpServer } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
      });

      await db
        .delete(schema.mcpServersTable)
        .where(eq(schema.mcpServersTable.id, mcpServer.id));

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found).toBeNull();
    });
  });

  describe("deleteByConversationId", () => {
    test("removes the row", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
      });

      await ConversationSandboxModel.deleteByConversationId(conversation.id);

      const found = await ConversationSandboxModel.findByConversationId(
        conversation.id,
      );
      expect(found).toBeNull();
    });

    test("does not throw for non-existent conversation", async ({
      makeAgent,
      makeConversation,
    }) => {
      const agent = await makeAgent();
      const conversation = await makeConversation(agent.id);
      await expect(
        ConversationSandboxModel.deleteByConversationId(conversation.id),
      ).resolves.not.toThrow();
    });
  });

  describe("findIdleAfter", () => {
    test("returns running rows whose lastActivityAt is older than the threshold", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const oldThreshold = new Date("2026-05-01T12:00:00Z");

      const stale = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "running",
      });
      await ConversationSandboxModel.bumpLastActivity(
        stale.conversation.id,
        new Date("2026-05-01T11:00:00Z"),
      );

      const fresh = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "running",
      });
      await ConversationSandboxModel.bumpLastActivity(
        fresh.conversation.id,
        new Date("2026-05-01T13:00:00Z"),
      );

      const idle = await ConversationSandboxModel.findIdleAfter(oldThreshold);
      const idleIds = idle.map((row) => row.conversationId);

      expect(idleIds).toContain(stale.conversation.id);
      expect(idleIds).not.toContain(fresh.conversation.id);
    });

    test("excludes rows still in provisioning state", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "provisioning",
      });
      await ConversationSandboxModel.bumpLastActivity(
        conversation.id,
        new Date("2026-05-01T11:00:00Z"),
      );

      const idle = await ConversationSandboxModel.findIdleAfter(
        new Date("2026-05-01T12:00:00Z"),
      );
      const idleIds = idle.map((row) => row.conversationId);
      expect(idleIds).not.toContain(conversation.id);
    });

    test("excludes rows where lastActivityAt is null (unbumped)", async ({
      makeAgent,
      makeMcpServer,
      makeConversation,
    }) => {
      const { conversation } = await seedSandbox({
        makeAgent,
        makeMcpServer,
        makeConversation,
        state: "running",
      });
      // Do not bump; lastActivityAt stays null.

      const idle = await ConversationSandboxModel.findIdleAfter(
        new Date("2026-05-01T12:00:00Z"),
      );
      const idleIds = idle.map((row) => row.conversationId);
      expect(idleIds).not.toContain(conversation.id);
    });
  });
});
