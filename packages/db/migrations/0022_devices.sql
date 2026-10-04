CREATE TABLE "device_grants" (
	"device_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"label" text NOT NULL,
	"providers" text[] NOT NULL,
	CONSTRAINT "device_grants_device_id_grant_id_pk" PRIMARY KEY("device_id","grant_id")
);
--> statement-breakpoint
CREATE TABLE "device_pairings" (
	"device_code_hash" text PRIMARY KEY NOT NULL,
	"user_code" text NOT NULL,
	"device_name" text NOT NULL,
	"confirmed_by_user_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "device_pairings_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "session_agent_hosts" (
	"session_agent_id" uuid PRIMARY KEY NOT NULL,
	"device_id" uuid NOT NULL,
	"grant_id" text NOT NULL,
	"token_id" uuid
);
--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_pairings" ADD CONSTRAINT "device_pairings_confirmed_by_user_id_users_id_fk" FOREIGN KEY ("confirmed_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_agent_hosts" ADD CONSTRAINT "session_agent_hosts_session_agent_id_session_agents_id_fk" FOREIGN KEY ("session_agent_id") REFERENCES "public"."session_agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_agent_hosts" ADD CONSTRAINT "session_agent_hosts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_agent_hosts" ADD CONSTRAINT "session_agent_hosts_token_id_session_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."session_tokens"("id") ON DELETE set null ON UPDATE no action;