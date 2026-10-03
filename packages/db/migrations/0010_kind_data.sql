ALTER TABLE "outputs" ADD COLUMN "kind_data" jsonb;--> statement-breakpoint
-- Kind-owned data moves into one opaque column (ADR 0023): latex's build report.
UPDATE "outputs" SET "kind_data" = jsonb_build_object('build', "build") WHERE "build" IS NOT NULL;
