CREATE TABLE "oauth_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"issuer" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"client_id" text NOT NULL,
	"sealed_client_secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_clients_issuer_redirect" UNIQUE("issuer","redirect_uri")
);
--> statement-breakpoint
CREATE TABLE "oauth_flows" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"entry" text NOT NULL,
	"sealed_verifier" text NOT NULL,
	"oauth_client_id" uuid,
	"token_endpoint" text NOT NULL,
	"fields" jsonb,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "entry" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth" text DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "sealed_refresh_token" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "token_endpoint" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "headers" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "status" text DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_oauth_client_id_oauth_clients_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;