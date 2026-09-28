CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"url" text NOT NULL,
	"sealed_credential" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_owner_slug" UNIQUE("owner_id","slug")
);
--> statement-breakpoint
CREATE TABLE "session_mcp_servers" (
	"session_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"added_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_mcp_servers_session_id_mcp_server_id_pk" PRIMARY KEY("session_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "session_mcp_tool_grants" (
	"session_id" uuid NOT NULL,
	"server_slug" text NOT NULL,
	"tool_name" text NOT NULL,
	"allowed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "session_mcp_tool_grants_session_id_server_slug_tool_name_pk" PRIMARY KEY("session_id","server_slug","tool_name")
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD CONSTRAINT "session_mcp_servers_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD CONSTRAINT "session_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD CONSTRAINT "session_mcp_servers_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_mcp_tool_grants" ADD CONSTRAINT "session_mcp_tool_grants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;