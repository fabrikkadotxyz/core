CREATE TABLE "session_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"status" text,
	"status_at" timestamp with time zone,
	"added_by_participant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_links_session_url" UNIQUE("session_id","url")
);
--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_links" ADD CONSTRAINT "session_links_added_by_participant_id_participants_id_fk" FOREIGN KEY ("added_by_participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;