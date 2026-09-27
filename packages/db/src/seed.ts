/**
 * Dev convenience: attach a demo session to an existing account.
 *
 * Deliberately does NOT create users. Accounts are born exactly one way —
 * `pnpm admin create-user` — so there is a single bootstrap path and no seeded
 * credentials that could survive into a real deployment (ADR 0007).
 *
 * Idempotent: safe to re-run.
 */
import { asc, eq } from 'drizzle-orm';
import { createClient } from './index.ts';
import {
  messages,
  participants,
  sessionMembers,
  sessions,
  users,
} from './schema.ts';

const { sql, db } = createClient();

const SESSION_PUBLIC_ID = 'demo';

async function main() {
  const [owner] = await db
    .select()
    .from(users)
    .orderBy(asc(users.createdAt))
    .limit(1);

  if (!owner) {
    console.error('no users exist yet. Create the first account first:');
    console.error('  pnpm admin create-user --email you@example.com --owner');
    process.exitCode = 1;
    return;
  }

  const [existing] = await db
    .select()
    .from(sessions)
    .where(eq(sessions.publicId, SESSION_PUBLIC_ID))
    .limit(1);

  if (existing) {
    console.log(`session "${SESSION_PUBLIC_ID}" already seeded`);
    console.log(`  http://localhost:5173/o/${owner.ownerSlug}/s/${SESSION_PUBLIC_ID}`);
    return;
  }

  const [session] = await db
    .insert(sessions)
    .values({
      publicId: SESSION_PUBLIC_ID,
      ownerId: owner.id,
      title: 'Debug Stripe webhook',
    })
    .returning();

  await db
    .insert(sessionMembers)
    .values({ sessionId: session!.id, userId: owner.id, role: 'owner' });

  const inserted = await db
    .insert(participants)
    .values([
      {
        sessionId: session!.id,
        kind: 'human',
        userId: owner.id,
        displayName: owner.displayName,
      },
      // Display-only until M3 gives agents real identities and connections.
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
      authorParticipantId: byName.get(owner.displayName)!.id,
      content: "I think this started after yesterday's deployment.",
    },
    {
      sessionId: session!.id,
      authorParticipantId: byName.get('claude-fede')!.id,
      content: 'I found three relevant commits touching the webhook handler.',
    },
  ]);

  console.log(`seeded session "${SESSION_PUBLIC_ID}" owned by ${owner.email}`);
  console.log(`  http://localhost:5173/o/${owner.ownerSlug}/s/${SESSION_PUBLIC_ID}`);
}

await main();
await sql.end();
