ALTER TYPE "public"."conversation_share_visibility" ADD VALUE 'public';--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD COLUMN "public_token" text;--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_public_token_unique" UNIQUE("public_token");