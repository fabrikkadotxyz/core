ALTER TABLE "sessions" DROP CONSTRAINT "sessions_team_id_teams_id_fk";
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;