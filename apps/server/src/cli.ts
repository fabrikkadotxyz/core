/**
 * Admin CLI.
 *
 * Every operation that would otherwise need a mail server lives here — most
 * importantly `reset-password`, which IS the password recovery path (ADR 0007).
 * Documented in docs/operations.md.
 *
 * A thin wrapper over the same functions the HTTP API uses, so the two cannot
 * drift apart in behaviour.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createClient } from '@fabrikka/db';
import {
  countUsers,
  createUser,
  listUsers,
  resetPassword,
} from './users.ts';
import { agentCounts } from './onboarding.ts';
import { deactivateUser, deleteUserNow, findUserForLeaving, GRACE_DAYS, previewDeletion, reactivateUser, scheduleDeletion } from './leaving.ts';
import { audit, auditForInstance, type AuditAction } from './audit.ts';
import { BackupError, createBackup, listBackups, readManifest, restoreBackup } from './backup.ts';
import { STORAGE_DIR } from './artifacts.ts';
/** M60 (ADR 0058): every command leaves one event, as the operator. */
const record = (action: AuditAction, e: { subjectUserId?: string | null; detail?: Record<string, string | number | boolean | null> } = {}) =>
  audit(db, { action, actorKind: 'operator', ...e });

const USAGE = `fabrikka admin

  create-user   --email <email> [--name <display name>] [--owner] [--password-stdin]
  reset-password --email <email> [--password-stdin]
  list-users
  deactivate-user --email <email>       cannot sign in; nothing else changes (M58)
  reactivate-user --email <email>       undo that, or cancel a pending deletion
  delete-user   --email <email> [--erase-name] [--now] [--yes]
                                personal data goes, what they wrote stays (ADR 0057);
                                scheduled after ${GRACE_DAYS} days unless --now
  agents                        how many people use, and wish for, each agent tool (counts only)
  audit         [--team <id>] [--since <YYYY-MM-DD>] [--action <prefix>] [--limit <n>]
                                the trail: who did what (M60, ADR 0058), newest first
  backup        [--to <dir>]    one encrypted archive: database + files (M61); FABRIKKA_BACKUP_KEY
  backups       [--dir <dir>]   the archives in a directory, newest first
  restore       --file <archive> [--force]
                                into an empty instance (DATABASE_URL, ARTIFACT_DIR); --force replaces

Passwords are read from a TTY prompt, or from stdin with --password-stdin so
they never appear in shell history or ps output:

  printf '%s' "$PASSWORD" | pnpm admin create-user --email you@example.com --owner --password-stdin
`;

function flag(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  return value && !value.startsWith('--') ? value : undefined;
}

function has(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

async function readPassword(argv: string[], prompt: string): Promise<string> {
  if (has(argv, 'password-stdin')) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(chunk as Buffer);
    const value = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    if (!value) throw new Error('--password-stdin given but stdin was empty');
    return value;
  }

  if (!stdin.isTTY) {
    throw new Error(
      'no TTY available for a password prompt; use --password-stdin',
    );
  }

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const first = await rl.question(prompt);
    const again = await rl.question('Confirm: ');
    if (first !== again) throw new Error('passwords did not match');
    return first;
  } finally {
    rl.close();
  }
}

const argv = process.argv.slice(2);
const command = argv[0];
const { sql, db } = createClient();

/** Thrown by die() so the finally block still closes the pool. */
class ExitSignal extends Error {}

/**
 * A function declaration rather than a const arrow: TypeScript only applies
 * never-return narrowing to declared functions, which is what lets callers
 * write `const x = flag(...) ?? die(...)`.
 */
function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exitCode = 1;
  throw new ExitSignal();
}

try {
  switch (command) {
    case 'create-user': {
      const email = flag(argv, 'email') ?? die('--email is required');
      const name = flag(argv, 'name') ?? email.split('@')[0]!;
      const isInstanceOwner = has(argv, 'owner');

      const first = (await countUsers(db)) === 0;
      const password = await readPassword(argv, 'Password: ');

      const result = await createUser(db, {
        email,
        password,
        displayName: name,
        isInstanceOwner,
        // The operator's own command: a deployment's account cap doesn't apply (ADR 0041).
        guarded: false,
      });
      if (!result.ok) die(result.error);

      await record('admin.create_user', { subjectUserId: result.user.id, detail: { instanceOwner: isInstanceOwner } });
      console.log(`created ${result.user.email}`);
      console.log(`  display name  ${result.user.displayName}`);
      console.log(`  owner slug    ${result.user.ownerSlug}   (appears in MCP URLs)`);
      console.log(`  instance owner ${result.user.isInstanceOwner}`);
      if (first && !isInstanceOwner) {
        console.log(
          '\nnote: this is the first account but --owner was not given.',
        );
      }
      break;
    }

    case 'reset-password': {
      const email = flag(argv, 'email') ?? die('--email is required');
      const password = await readPassword(argv, 'New password: ');

      const result = await resetPassword(db, email, password);
      if (!result.ok) die(result.error);

      await record('admin.reset_password', { subjectUserId: (await findUserForLeaving(db, email))?.id ?? null });
      console.log(`password reset for ${email}`);
      console.log('every existing login for this account has been invalidated');
      break;
    }

    case 'list-users': {
      const rows = await listUsers(db);
      if (rows.length === 0) {
        console.log('no users yet — create one with: admin create-user --email <e> --owner');
        break;
      }
      for (const u of rows) {
        const owner = u.isInstanceOwner ? ' [instance owner]' : '';
        // M58: a deleted account has no address; a deactivated one says so.
        const state = u.deletedAt ? ' [deleted]' : u.deletionRequestedAt ? ' [deletion pending]' : u.deactivatedAt ? ' [deactivated]' : '';
        const address = u.deletedAt ? '(deleted)' : u.email;
        console.log(
          `${address}  (${u.displayName}, slug ${u.ownerSlug})  ${u.createdAt.toISOString().slice(0, 10)}${owner}${state}`,
        );
      }
      break;
    }

    case 'deactivate-user': {
      const email = flag(argv, 'email') ?? die('--email is required');
      const user = (await findUserForLeaving(db, email)) ?? die('no such user');
      if (!(await deactivateUser(db, user.id))) die('that account is deleted');
      await record('admin.deactivate_user', { subjectUserId: user.id });
      console.log(`deactivated ${email}: cannot sign in; nothing else changed. Undo with reactivate-user.`);
      break;
    }

    case 'reactivate-user': {
      const email = flag(argv, 'email') ?? die('--email is required');
      const user = (await findUserForLeaving(db, email)) ?? die('no such user');
      if (!(await reactivateUser(db, user.id))) die('that account is deleted and cannot come back');
      await record('admin.reactivate_user', { subjectUserId: user.id, detail: { cancelledDeletion: !!user.deletionRequestedAt } });
      console.log(`reactivated ${email}${user.deletionRequestedAt ? ' and cancelled its deletion' : ''}`);
      break;
    }

    case 'agents': {
      // 2026-10-17: the welcome's answers, as counts. Says which adapter to build next.
      const { used, wanted, answered } = await agentCounts(db);
      console.log(`${answered} account${answered === 1 ? '' : 's'} answered the welcome's agent question.`);
      const print = (title: string, counts: Record<string, number>) => {
        console.log(`\n${title}`);
        const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        if (rows.length === 0) console.log('  (none yet)');
        for (const [k, n] of rows) console.log(`  ${String(n).padStart(4)}  ${k}`);
      };
      print('Used:', used);
      print('Wished for (not run yet):', wanted);
      break;
    }

    case 'delete-user': {
      // M58 (ADR 0057): never a row delete. Says what will happen, then does it.
      const email = flag(argv, 'email') ?? die('--email is required');
      const eraseName = has(argv, 'erase-name');
      const user = (await findUserForLeaving(db, email)) ?? die('no such user');
      if (user.deletedAt) die('that account is already deleted');
      const plan = (await previewDeletion(db, user.id)) ?? die('no such user');
      const list = (title: string, rows: string[]) => {
        if (rows.length === 0) return;
        console.log(`${title}`);
        for (const r of rows) console.log(`  ${r}`);
      };
      list('Rooms nobody else is in, deleted with their content:', plan.soloSessions.map((s) => `"${s.title}"`));
      list('Rooms passed to their oldest remaining member:', plan.passedSessions.map((s) => `"${s.title}" → ${s.toName}`));
      list('Organizations passed to their oldest remaining member:', plan.passedTeams.map((t) => `"${t.name}" → ${t.toName}`));
      list('Organizations kept without an owner (a room in them has another person):', plan.ownerlessTeams.map((t) => `"${t.name}"`));
      list('Organizations nobody else is in, deleted:', plan.deletedTeams.map((t) => `"${t.name}"`));
      console.log(
        eraseName
          ? 'What they wrote in rooms other people are in stays, under the name "former-member".'
          : `What they wrote in rooms other people are in stays, under "${user.displayName}", marked as deactivated.`,
      );
      if (!has(argv, 'now')) {
        const r = await scheduleDeletion(db, user.id, { eraseName });
        if (!r.ok) die(r.error);
        await record('admin.delete_user', { subjectUserId: user.id, detail: { eraseName, now: false, effectiveAt: r.effectiveAt.toISOString() } });
        console.log(`${email} is deactivated now and will be deleted on ${r.effectiveAt.toISOString().slice(0, 10)}. A sign-in before then cancels it.`);
        break;
      }
      if (!has(argv, 'yes')) {
        const rl = createInterface({ input: stdin, output: stdout });
        const typed = await rl.question(`This cannot be undone. Type the address to confirm: `);
        rl.close();
        if (typed.trim().toLowerCase() !== email.trim().toLowerCase()) die('addresses differ; nothing done');
      }
      if (eraseName) await scheduleDeletion(db, user.id, { eraseName });
      const report = (await deleteUserNow(db, user.id)) ?? die('nothing to delete');
      await record('admin.delete_user', {
        subjectUserId: user.id,
        detail: { eraseName, now: true, roomsDeleted: report.soloSessions.length, roomsPassed: report.passedSessions.length, teamsPassed: report.passedTeams.length, teamsDeleted: report.deletedTeams.length },
      });
      console.log(`deleted ${email}: ${report.soloSessions.length} room(s) removed, ${report.passedSessions.length} passed on, ${report.participantsRenamed} name(s) replaced.`);
      break;
    }

    case 'backup': {
      // M61: dump, bundle, encrypt. The passphrase never lands in the archive.
      const dir = flag(argv, 'to') ?? process.env.FABRIKKA_BACKUP_DIR ?? die('--to <dir> or FABRIKKA_BACKUP_DIR is required');
      const passphrase = process.env.FABRIKKA_BACKUP_KEY ?? die('FABRIKKA_BACKUP_KEY is required: the passphrase the archive is sealed with');
      try {
        const r = await createBackup({
          databaseUrl: process.env.DATABASE_URL!,
          artifactDir: STORAGE_DIR,
          passphrase,
          dir,
          publicUrl: process.env.PUBLIC_URL ?? null,
        });
        await record('admin.backup', { detail: { bytes: r.bytes, artifacts: r.manifest.artifacts.count, databaseBytes: r.manifest.database.bytes } });
        console.log(`wrote ${r.file}`);
        console.log(`  ${(r.bytes / 1024 / 1024).toFixed(1)} MB: database ${(r.manifest.database.bytes / 1024 / 1024).toFixed(1)} MB, ${r.manifest.artifacts.count} file(s)`);
        console.log(`manifest ${JSON.stringify(r.manifest)}`);
      } catch (err) {
        if (err instanceof BackupError) die(err.message);
        throw err;
      }
      break;
    }

    case 'backups': {
      const dir = flag(argv, 'dir') ?? process.env.FABRIKKA_BACKUP_DIR ?? die('--dir <dir> or FABRIKKA_BACKUP_DIR is required');
      const all = await listBackups(dir);
      if (all.length === 0) console.log(`no archives in ${dir}`);
      for (const b of all) console.log(`${b.modifiedAt.toISOString()}  ${(b.bytes / 1024 / 1024).toFixed(1).padStart(8)} MB  ${b.file}`);
      break;
    }

    case 'restore': {
      // M61: into an empty instance. The database this CLI is pointed at (DATABASE_URL) is the target.
      const file = flag(argv, 'file') ?? die('--file <archive> is required');
      const passphrase = process.env.FABRIKKA_BACKUP_KEY ?? die('FABRIKKA_BACKUP_KEY is required: the passphrase the archive was sealed with');
      try {
        const peek = await readManifest(file, passphrase);
        console.log(`archive from ${peek.createdAt}${peek.publicUrl ? ` (${peek.publicUrl})` : ''}: database ${(peek.database.bytes / 1024 / 1024).toFixed(1)} MB, ${peek.artifacts.count} file(s)`);
        const manifest = await restoreBackup({
          file,
          databaseUrl: process.env.DATABASE_URL!,
          artifactDir: STORAGE_DIR,
          passphrase,
          force: has(argv, 'force'),
          hasTables: async () => {
            const [row] = await sql<{ n: string }[]>`select count(*)::text as n from information_schema.tables where table_schema = 'public'`;
            return Number(row?.n ?? 0) > 0;
          },
        });
        await record('admin.restore', { detail: { from: manifest.createdAt, artifacts: manifest.artifacts.count, force: has(argv, 'force') } });
        console.log(`restored: ${manifest.artifacts.count} file(s) into ${STORAGE_DIR}, the database from ${manifest.createdAt}. Start the server; it applies any newer migrations.`);
      } catch (err) {
        if (err instanceof BackupError) die(err.message);
        throw err;
      }
      break;
    }

    case 'audit': {
      // M60 (ADR 0058): the operator reads everything.
      const since = flag(argv, 'since');
      const events = await auditForInstance(db, {
        teamId: flag(argv, 'team'),
        since: since ? new Date(since) : undefined,
        action: flag(argv, 'action'),
        limit: Number(flag(argv, 'limit') ?? 100),
      });
      if (events.length === 0) console.log('no events');
      for (const e of events) {
        const who = e.actor.userId ? (e.actor.name ?? e.actor.userId) : e.actor.kind;
        const whom = e.subject ? ` → ${e.subject.name ?? e.subject.userId}` : '';
        const where = [e.team?.name, e.session?.title].filter(Boolean).join(' / ');
        const detail = Object.keys(e.detail).length ? `  ${JSON.stringify(e.detail)}` : '';
        console.log(`${e.at}  ${e.action.padEnd(28)} ${e.outcome.padEnd(7)} ${who}${whom}${where ? `  [${where}]` : ''}${e.ip ? `  ${e.ip}` : ''}${detail}`);
      }
      break;
    }

    default:
      console.log(USAGE);
      if (command) process.exitCode = 1;
  }
} catch (err) {
  if (!(err instanceof ExitSignal)) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
} finally {
  await sql.end();
}
