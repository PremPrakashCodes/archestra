import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import type { SandboxState } from "@/types/conversation-sandbox";
import conversationsTable from "./conversation";
import mcpServerTable from "./mcp-server";

const conversationSandboxesTable = pgTable("conversation_sandbox", {
  conversationId: uuid("conversation_id")
    .primaryKey()
    .references(() => conversationsTable.id, { onDelete: "cascade" }),
  mcpServerId: uuid("mcp_server_id")
    .notNull()
    .references(() => mcpServerTable.id, { onDelete: "cascade" }),
  state: text("state").notNull().default("provisioning").$type<SandboxState>(),
  podName: text("pod_name"),
  pvcName: text("pvc_name").notNull(),
  lastActivityAt: timestamp("last_activity_at", { mode: "date" }),
  idleDeadlineAt: timestamp("idle_deadline_at", { mode: "date" }),
  provisioningError: text("provisioning_error"),
  createdAt: timestamp("created_at", { mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export default conversationSandboxesTable;
