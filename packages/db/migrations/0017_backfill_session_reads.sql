-- M24: start "since you were away" fresh. Without a read position every past
-- mention would count as unseen, so every existing member is marked as having
-- looked at each of their sessions now, with today's context as the snapshot.
INSERT INTO "session_reads" ("session_id", "user_id", "last_seen_at", "context_seen")
SELECT sm."session_id", sm."user_id", now(),
       jsonb_build_object(
         'facts',       coalesce(sc."facts", '[]'::jsonb),
         'decisions',   coalesce(sc."decisions", '[]'::jsonb),
         'questions',   coalesce(sc."questions", '[]'::jsonb),
         'constraints', coalesce(sc."constraints", '[]'::jsonb)
       )
FROM "session_members" sm
LEFT JOIN "session_context" sc ON sc."session_id" = sm."session_id"
ON CONFLICT ("session_id", "user_id") DO NOTHING;
