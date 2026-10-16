-- ADR 0051 (amended 2026-10-16): the own organization is named "Self". The ones
-- made so far were named after the person; rename those still carrying that name.
UPDATE "teams" t SET "name" = 'Self' FROM "users" u WHERE t."own_of_user_id" = u."id" AND t."name" = u."display_name";--> statement-breakpoint
-- Self has no #general: a chat with yourself is not a chat. Remove the ones made
-- automatically, as long as nothing was ever said in them.
DELETE FROM "sessions" s USING "teams" t
WHERE s."team_id" = t."id" AND t."own_of_user_id" IS NOT NULL AND s."kind" = 'chat' AND s."title" = 'general'
  AND NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."session_id" = s."id");
