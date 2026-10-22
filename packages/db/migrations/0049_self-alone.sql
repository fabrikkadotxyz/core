-- M68 (ADR 0062): Self has exactly one member, its person.
-- Open organization invites to a Self are revoked.
UPDATE "session_invites" i SET "revoked_at" = now()
FROM "teams" t
WHERE i."team_id" = t."id" AND t."own_of_user_id" IS NOT NULL
  AND i."revoked_at" IS NULL AND i."redeemed_at" IS NULL;--> statement-breakpoint
-- Session access that came from being on someone else's Self goes with it; direct invites stay.
DELETE FROM "session_members" sm
USING "teams" t
WHERE sm."via_team_id" = t."id" AND t."own_of_user_id" IS NOT NULL AND sm."user_id" <> t."own_of_user_id";--> statement-breakpoint
DELETE FROM "team_members" tm
USING "teams" t
WHERE tm."team_id" = t."id" AND t."own_of_user_id" IS NOT NULL AND tm."user_id" <> t."own_of_user_id";
