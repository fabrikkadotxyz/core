ALTER TABLE "sessions" ADD COLUMN "kind" text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "direct_key" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_direct_key_unique" UNIQUE("direct_key");