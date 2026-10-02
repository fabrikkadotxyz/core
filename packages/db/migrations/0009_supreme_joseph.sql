CREATE TABLE "output_edits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_id" uuid NOT NULL,
	"file" text NOT NULL,
	"participant_id" uuid,
	"run_id" uuid,
	"external_author" text,
	"version" integer NOT NULL,
	"added_lines" integer NOT NULL,
	"removed_lines" integer NOT NULL,
	"diff" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"main_file" text NOT NULL,
	"state" "bytea",
	"external_ref" text,
	"version" integer DEFAULT 0 NOT NULL,
	"build" jsonb,
	"created_by_participant_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "output_edits" ADD CONSTRAINT "output_edits_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_edits" ADD CONSTRAINT "output_edits_participant_id_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_edits" ADD CONSTRAINT "output_edits_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outputs" ADD CONSTRAINT "outputs_created_by_participant_id_participants_id_fk" FOREIGN KEY ("created_by_participant_id") REFERENCES "public"."participants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "output_edits_output_created_idx" ON "output_edits" USING btree ("output_id","created_at");--> statement-breakpoint
CREATE INDEX "outputs_session_idx" ON "outputs" USING btree ("session_id");