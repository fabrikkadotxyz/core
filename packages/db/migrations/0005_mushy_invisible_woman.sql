CREATE TABLE "session_turn_budget" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone DEFAULT now() NOT NULL,
	"agent_turns_used" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agents_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agents_paused_reason" text;--> statement-breakpoint
ALTER TABLE "session_turn_budget" ADD CONSTRAINT "session_turn_budget_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;