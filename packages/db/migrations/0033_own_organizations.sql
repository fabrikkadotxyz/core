ALTER TABLE "teams" ADD COLUMN "own_of_user_id" uuid;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_own_of_user_id_users_id_fk" FOREIGN KEY ("own_of_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_own_of_user_id_unique" UNIQUE("own_of_user_id");--> statement-breakpoint
-- M53 (ADR 0051): every account gets its own organization, named after the person,
-- and the sessions it owns in no organization move into it. Nobody gains access:
-- the organization has one member and the sessions keep theirs.
INSERT INTO "teams" ("name", "created_by_user_id", "own_of_user_id")
SELECT u."display_name", u."id", u."id" FROM "users" u
WHERE NOT EXISTS (SELECT 1 FROM "teams" t WHERE t."own_of_user_id" = u."id");--> statement-breakpoint
INSERT INTO "team_members" ("team_id", "user_id", "role")
SELECT t."id", t."own_of_user_id", 'owner' FROM "teams" t
WHERE t."own_of_user_id" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "sessions" s SET "team_id" = t."id"
FROM "teams" t
WHERE s."team_id" IS NULL AND s."kind" <> 'direct' AND t."own_of_user_id" = s."owner_id";--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_in_organization" CHECK ("sessions"."kind" = 'direct' or "sessions"."team_id" is not null);