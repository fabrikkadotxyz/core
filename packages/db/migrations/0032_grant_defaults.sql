CREATE TABLE "grant_defaults" (
	"user_id" uuid NOT NULL,
	"server_slug" text NOT NULL,
	"name" text DEFAULT 'default' NOT NULL,
	"tools" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_defaults_user_id_server_slug_name_pk" PRIMARY KEY("user_id","server_slug","name")
);
--> statement-breakpoint
ALTER TABLE "grant_defaults" ADD CONSTRAINT "grant_defaults_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;