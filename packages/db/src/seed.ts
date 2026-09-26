/**
 * M0 seed: one hardcoded session so the timeline has something to render
 * before auth exists (M1). Idempotent — safe to re-run.
 */
import { eq } from 'drizzle-orm';
import { createClient } from './index.ts';
import { messages, participants, sessions, users } from './schema.ts';

const { sql, db } = createClient();

const OWNER_SLUG = 'fede';
const SESSION_PUBLIC_ID = 'demo';

const existing = await db
  .select()
  .from(sessions)
  .where(eq(sessions.publicId, SESSION_PUBLIC_ID));

if (existing.length > 0) {
  console.log(`session "${SESSION_PUBLIC_ID}" already seeded`);
  await sql.end();
  process.exit(0);
}

const [fede] = await db
  .insert(users)
  .values({
    ownerSlug: OWNER_SLUG,
    email: 'fede@example.com',
    displayName: 'fede',
  })
  .onConflictDoNothing()
  .returning();

const owner =
  fede ??
  (await db.select().from(users).where(eq(users.ownerSlug, OWNER_SLUG)))[0]!;

const [alice] = await db
  .insert(users)
  .values({
    ownerSlug: 'alice',
    email: 'alice@example.com',
    displayName: 'alice',
  })
  .onConflictDoNothing()
  .returning();

const [session] = await db
  .insert(sessions)
  .values({
    publicId: SESSION_PUBLIC_ID,
    ownerId: owner.id,
    title: 'Debug Stripe webhook',
  })
  .returning();

const inserted = await db
  .insert(participants)
  .values([
    {
      sessionId: session!.id,
      kind: 'human',
      userId: owner.id,
      displayName: 'fede',
    },
    {
      sessionId: session!.id,
      kind: 'human',
      userId: alice?.id,
      displayName: 'alice',
    },
    // Display-only at M0 — agents get real identities and connections at M3.
    // Seeded now because participants is one id space for humans and agents,
    // and the timeline should exercise both from the start.
    {
      sessionId: session!.id,
      kind: 'agent',
      displayName: 'claude-fede',
    },
  ])
  .returning();

const byName = new Map(inserted.map((p) => [p.displayName, p]));

await db.insert(messages).values([
  {
    sessionId: session!.id,
    authorParticipantId: byName.get('fede')!.id,
    content: "I think this started after yesterday's deployment.",
  },
  {
    sessionId: session!.id,
    authorParticipantId: byName.get('claude-fede')!.id,
    content: 'I found three relevant commits touching the webhook handler.',
  },
]);

console.log(`seeded session "${SESSION_PUBLIC_ID}" owned by "${OWNER_SLUG}"`);
console.log(`  open http://localhost:5173/o/${OWNER_SLUG}/s/${SESSION_PUBLIC_ID}`);

await sql.end();
