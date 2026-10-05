CREATE TABLE "team_mcp_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_mcp_server_id" uuid NOT NULL,
	"session_id" uuid,
	"user_id" uuid,
	"agent_name" text,
	"tool_name" text NOT NULL,
	"ok" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"sealed_credential" text,
	"added_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_mcp_servers_team_slug" UNIQUE("team_id","slug")
);
--> statement-breakpoint
ALTER TABLE "team_mcp_calls" ADD CONSTRAINT "team_mcp_calls_team_mcp_server_id_team_mcp_servers_id_fk" FOREIGN KEY ("team_mcp_server_id") REFERENCES "public"."team_mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_mcp_calls" ADD CONSTRAINT "team_mcp_calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_mcp_calls" ADD CONSTRAINT "team_mcp_calls_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_mcp_servers" ADD CONSTRAINT "team_mcp_servers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_mcp_servers" ADD CONSTRAINT "team_mcp_servers_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_mcp_calls_server_idx" ON "team_mcp_calls" USING btree ("team_mcp_server_id","created_at");