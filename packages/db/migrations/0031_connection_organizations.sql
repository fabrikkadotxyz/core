ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_owner_slug";--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "session_mcp_servers" ADD COLUMN "from_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_flows" ADD CONSTRAINT "oauth_flows_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_team_slug" UNIQUE NULLS NOT DISTINCT("owner_id","team_id","slug");--> statement-breakpoint
-- ADR 0043: connections attached in an organization's room before connections had organizations keep working, marked.
UPDATE "session_mcp_servers" sms SET "from_personal" = true
  FROM "sessions" s WHERE s.id = sms.session_id AND s.team_id IS NOT NULL;
