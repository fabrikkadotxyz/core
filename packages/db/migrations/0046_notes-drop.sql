-- M65 (ADR 0059): the old form becomes tagged notes before it goes. Author and
-- time come from context_events where it has them; a template's items, and
-- anything older than M27's history, keep the row's last update time.
INSERT INTO session_notes (session_id, participant_id, text, tag, created_at)
SELECT c.session_id, e.participant_id, c.objective, 'goal', coalesce(e.created_at, c.updated_at)
FROM session_context c
LEFT JOIN LATERAL (
  SELECT ev.participant_id, ev.created_at FROM context_events ev
  WHERE ev.session_id = c.session_id AND ev.field = 'objective' AND ev.op = 'set' AND ev.value = c.objective
  ORDER BY ev.created_at DESC, ev.seq DESC LIMIT 1
) e ON true
WHERE c.objective IS NOT NULL AND btrim(c.objective) <> '';--> statement-breakpoint
INSERT INTO session_notes (session_id, participant_id, text, tag, created_at)
SELECT c.session_id, e.participant_id, items.value, items.tag, coalesce(e.created_at, c.updated_at)
FROM session_context c
CROSS JOIN LATERAL (
  SELECT f.value, 'fact'::text AS tag, 1 AS grp, f.ord FROM jsonb_array_elements_text(coalesce(c.facts, '[]'::jsonb)) WITH ORDINALITY AS f(value, ord)
  UNION ALL SELECT d.value, 'decision', 2, d.ord FROM jsonb_array_elements_text(coalesce(c.decisions, '[]'::jsonb)) WITH ORDINALITY AS d(value, ord)
  UNION ALL SELECT q.value, 'question', 3, q.ord FROM jsonb_array_elements_text(coalesce(c.questions, '[]'::jsonb)) WITH ORDINALITY AS q(value, ord)
  UNION ALL SELECT k.value, 'constraint', 4, k.ord FROM jsonb_array_elements_text(coalesce(c.constraints, '[]'::jsonb)) WITH ORDINALITY AS k(value, ord)
) items
LEFT JOIN LATERAL (
  SELECT ev.participant_id, ev.created_at FROM context_events ev
  WHERE ev.session_id = c.session_id AND ev.field = items.tag || 's' AND ev.op = 'add' AND ev.value = items.value
  ORDER BY ev.created_at DESC, ev.seq DESC LIMIT 1
) e ON true
WHERE btrim(items.value) <> ''
ORDER BY c.session_id, items.grp, items.ord;--> statement-breakpoint
-- Saved templates: an objective, constraints and questions become starter notes, tagged.
UPDATE session_templates SET body = jsonb_build_object(
  'notes',
    (CASE WHEN coalesce(body->>'objective', '') <> '' THEN jsonb_build_array(jsonb_build_object('text', body->>'objective', 'tag', 'goal')) ELSE '[]'::jsonb END)
    || coalesce((SELECT jsonb_agg(jsonb_build_object('text', x, 'tag', 'constraint')) FROM jsonb_array_elements_text(coalesce(body->'constraints', '[]'::jsonb)) x), '[]'::jsonb)
    || coalesce((SELECT jsonb_agg(jsonb_build_object('text', x, 'tag', 'question')) FROM jsonb_array_elements_text(coalesce(body->'questions', '[]'::jsonb)) x), '[]'::jsonb),
  'outputs', coalesce(body->'outputs', '[]'::jsonb),
  'connections', coalesce(body->'connections', '[]'::jsonb))
WHERE body ? 'objective' OR body ? 'constraints' OR body ? 'questions';--> statement-breakpoint
-- Each person's catch-up starts from the notes that exist now, not from an empty list.
UPDATE session_reads r SET notes_seen_seq = coalesce((SELECT max(n.seq) FROM session_notes n WHERE n.session_id = r.session_id), 0);--> statement-breakpoint
DROP TABLE "context_events" CASCADE;--> statement-breakpoint
DROP TABLE "session_context" CASCADE;--> statement-breakpoint
ALTER TABLE "session_reads" DROP COLUMN "context_seen";