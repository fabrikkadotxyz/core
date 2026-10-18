ALTER TABLE "teams" ADD COLUMN "message_days" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "output_days" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD COLUMN "file_days" integer;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_message_days" CHECK ("teams"."message_days" is null or "teams"."message_days" in (30, 90, 180, 365, 730));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_output_days" CHECK ("teams"."output_days" is null or "teams"."output_days" in (30, 90, 180, 365, 730));--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_file_days" CHECK ("teams"."file_days" is null or "teams"."file_days" in (30, 90, 180, 365, 730));