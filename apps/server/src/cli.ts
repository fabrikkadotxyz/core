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
  deleteUser,
  listUsers,
  resetPassword,
} from './users.ts';

const USAGE = `fabrikka admin

  create-user   --email <email> [--name <display name>] [--owner] [--password-stdin]
  reset-password --email <email> [--password-stdin]
  list-users
  delete-user   --email <email>

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
      });
      if (!result.ok) die(result.error);

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
        console.log(
          `${u.email}  (${u.displayName}, slug ${u.ownerSlug})  ${u.createdAt.toISOString().slice(0, 10)}${owner}`,
        );
      }
      break;
    }

    case 'delete-user': {
      const email = flag(argv, 'email') ?? die('--email is required');
      const result = await deleteUser(db, email);
      if (!result.ok) die(result.error);
      console.log(`deleted ${email} and all of their memberships`);
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
