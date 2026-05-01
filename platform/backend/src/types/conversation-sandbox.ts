import {
  createInsertSchema,
  createSelectSchema,
  createUpdateSchema,
} from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SandboxStateSchema = z.enum([
  "provisioning",
  "running",
  "idle-suspended",
  "stopped",
  "error",
]);

export type SandboxState = z.infer<typeof SandboxStateSchema>;

export const SelectConversationSandboxSchema = createSelectSchema(
  schema.conversationSandboxesTable,
).extend({
  state: SandboxStateSchema,
});

export const InsertConversationSandboxSchema = createInsertSchema(
  schema.conversationSandboxesTable,
)
  .extend({
    state: SandboxStateSchema.optional(),
  })
  .omit({
    createdAt: true,
    updatedAt: true,
  });

export const UpdateConversationSandboxSchema = createUpdateSchema(
  schema.conversationSandboxesTable,
)
  .pick({
    state: true,
    podName: true,
    pvcName: true,
    secretName: true,
    lastActivityAt: true,
    idleDeadlineAt: true,
    provisioningError: true,
  })
  .extend({
    state: SandboxStateSchema.optional(),
  });

export type ConversationSandbox = z.infer<
  typeof SelectConversationSandboxSchema
>;
export type InsertConversationSandbox = z.infer<
  typeof InsertConversationSandboxSchema
>;
export type UpdateConversationSandbox = z.infer<
  typeof UpdateConversationSandboxSchema
>;
