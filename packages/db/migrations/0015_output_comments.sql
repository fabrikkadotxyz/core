CREATE TABLE "output_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"output_id" uuid NOT NULL,
	"parent_id" uuid,
	"file" text NOT NULL,
	"quote" text,
	"body" text NOT NULL,
	"author_user_id" uuid NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by_user_id" uuid,
	"resolved_by_participant_id" uuid,
	"resolved_at_version" integer,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "output_comments" ADD CONSTRAINT "output_comments_output_id_outputs_id_fk" FOREIGN KEY ("output_id") REFERENCES "public"."outputs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_comments" ADD CONSTRAINT "output_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_comments" ADD CONSTRAINT "output_comments_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "output_comments" ADD CONSTRAINT "output_comments_resolved_by_participant_id_participants_id_fk" FOREIGN KEY ("resolved_by_participant_id") REFERENCES "public"."participants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "output_comments_output_created_idx" ON "output_comments" USING btree ("output_id","created_at");