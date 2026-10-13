ALTER TABLE "device_grants" ADD COLUMN "team_id" uuid;--> statement-breakpoint
ALTER TABLE "session_agent_hosts" ADD COLUMN "from_personal" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "device_grants" ADD CONSTRAINT "device_grants_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- ADR 0043: folders bound in an organization's room before folders had organizations keep working, marked.
UPDATE "session_agent_hosts" h SET "from_personal" = true
  FROM "session_agents" sa JOIN "sessions" s ON s.id = sa.session_id
  WHERE sa.id = h.session_agent_id AND s.team_id IS NOT NULL;
