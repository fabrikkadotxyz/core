CREATE INDEX "participants_user_idx" ON "participants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_guests_user_idx" ON "session_guests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_members_user_idx" ON "session_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_team_idx" ON "sessions" USING btree ("team_id");--> statement-breakpoint
CREATE INDEX "team_members_user_idx" ON "team_members" USING btree ("user_id");