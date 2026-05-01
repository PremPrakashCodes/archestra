CREATE TABLE "conversation_sandbox" (
	"conversation_id" uuid PRIMARY KEY NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"state" text DEFAULT 'provisioning' NOT NULL,
	"pod_name" text,
	"pvc_name" text NOT NULL,
	"secret_name" text NOT NULL,
	"last_activity_at" timestamp,
	"idle_deadline_at" timestamp,
	"provisioning_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_sandbox" ADD CONSTRAINT "conversation_sandbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_sandbox" ADD CONSTRAINT "conversation_sandbox_mcp_server_id_mcp_server_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_server"("id") ON DELETE cascade ON UPDATE no action;