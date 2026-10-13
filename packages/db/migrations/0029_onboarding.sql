ALTER TABLE "users" ADD COLUMN "welcomed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "getting_started_dismissed_at" timestamp with time zone;--> statement-breakpoint
-- M47: accounts from before onboarding are not stopped by the welcome.
UPDATE "users" SET "welcomed_at" = now() WHERE "welcomed_at" IS NULL;
