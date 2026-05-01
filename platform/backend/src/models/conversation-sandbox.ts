import { and, eq, isNotNull, lt, ne } from "drizzle-orm";
import db, { schema } from "@/database";
import type {
  ConversationSandbox,
  InsertConversationSandbox,
  UpdateConversationSandbox,
} from "@/types";

class ConversationSandboxModel {
  static async create(
    data: InsertConversationSandbox,
  ): Promise<ConversationSandbox> {
    const [row] = await db
      .insert(schema.conversationSandboxesTable)
      .values(data)
      .returning();
    return row as ConversationSandbox;
  }

  static async findByConversationId(
    conversationId: string,
  ): Promise<ConversationSandbox | null> {
    const [row] = await db
      .select()
      .from(schema.conversationSandboxesTable)
      .where(
        eq(schema.conversationSandboxesTable.conversationId, conversationId),
      )
      .limit(1);
    return (row as ConversationSandbox | undefined) ?? null;
  }

  static async update(
    conversationId: string,
    patch: UpdateConversationSandbox,
  ): Promise<ConversationSandbox | null> {
    const [row] = await db
      .update(schema.conversationSandboxesTable)
      .set(patch)
      .where(
        eq(schema.conversationSandboxesTable.conversationId, conversationId),
      )
      .returning();
    return (row as ConversationSandbox | undefined) ?? null;
  }

  static async bumpLastActivity(
    conversationId: string,
    at: Date = new Date(),
  ): Promise<void> {
    await db
      .update(schema.conversationSandboxesTable)
      .set({ lastActivityAt: at })
      .where(
        eq(schema.conversationSandboxesTable.conversationId, conversationId),
      );
  }

  static async deleteByConversationId(conversationId: string): Promise<void> {
    await db
      .delete(schema.conversationSandboxesTable)
      .where(
        eq(schema.conversationSandboxesTable.conversationId, conversationId),
      );
  }

  /**
   * Defensive sweep: find sandboxes whose lastActivityAt is older than the
   * given timestamp. Excludes rows still in `provisioning` (their pod has
   * not yet reported readiness, so the in-pod activity file may not exist).
   */
  static async findIdleAfter(olderThan: Date): Promise<ConversationSandbox[]> {
    const rows = await db
      .select()
      .from(schema.conversationSandboxesTable)
      .where(
        and(
          isNotNull(schema.conversationSandboxesTable.lastActivityAt),
          lt(schema.conversationSandboxesTable.lastActivityAt, olderThan),
          ne(schema.conversationSandboxesTable.state, "provisioning"),
        ),
      );
    return rows as ConversationSandbox[];
  }
}

export default ConversationSandboxModel;
