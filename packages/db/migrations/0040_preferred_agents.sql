ALTER TABLE "users" ADD COLUMN "preferred_agents" jsonb;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "wanted_agents" jsonb;--> statement-breakpoint
-- 2026-10-17: the one agent becomes a list of agents.
UPDATE "users" SET "preferred_agents" = jsonb_build_array("preferred_agent") WHERE "preferred_agent" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "preferred_agent";
