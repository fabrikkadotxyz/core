ALTER TABLE "session_invites" ADD COLUMN "max_uses" integer DEFAULT 1;--> statement-breakpoint
ALTER TABLE "session_invites" ADD COLUMN "uses" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
-- Links already used once are exhausted (ADR 0053 amended): uses follows redeemed_at.
UPDATE "session_invites" SET "uses" = 1 WHERE "redeemed_at" IS NOT NULL;
