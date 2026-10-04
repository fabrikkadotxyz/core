/**
 * Acceptance setup: make sure the dedicated test account exists.
 *
 * The checks create teams, sessions and agents as they run. They do it as
 * `acceptance@example.com`, never as a real person's account, so a developer's
 * own sidebar isn't filled with "Vis 1791…" teams and timestamped sessions.
 * Runs first (`_` sorts before `m`) and does nothing if the account exists.
 *
 * Override with FABRIKKA_TEST_EMAIL / FABRIKKA_TEST_PASSWORD.
 */
import { execFile } from 'node:child_process';

const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const PASSWORD = process.env.FABRIKKA_TEST_PASSWORD ?? 'fabrikka-dev-pw';

const login = await fetch('http://localhost:9090/api/auth/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
}).catch(() => null);

if (!login) {
  console.error('the server is not running on :9090 — start it first (pnpm dev)');
  process.exit(1);
}
if (login.ok) {
  console.log(`ok   test account ${EMAIL} exists`);
  process.exit(0);
}

// --password-stdin reads until stdin closes, so stdin must be ended.
await new Promise((resolve, reject) => {
  const child = execFile(
    'pnpm',
    ['admin', 'create-user', '--email', EMAIL, '--name', 'acceptance', '--owner', '--password-stdin'],
    (err, stdout, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve(stdout)),
  );
  child.stdin.end(PASSWORD);
}).catch((err) => {
  console.error(`could not create ${EMAIL}: ${err.message}`);
  process.exit(1);
});
console.log(`ok   created the test account ${EMAIL}`);
