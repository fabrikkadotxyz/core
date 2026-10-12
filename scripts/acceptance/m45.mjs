/**
 * M45 acceptance: email to any provider, over SMTP (ADR 0040).
 *
 * A tiny SMTP server here stands in for the provider. The core is started
 * against it, the way an operator would configure Resend or SES, and asked for
 * a password reset:
 *   - the mail arrives, from FABRIKKA_MAIL_FROM, to the right address, with the
 *     reset link, after logging in with the URL's (URL-encoded) credentials;
 *   - the URL, which holds the password, never reaches the server's output;
 *   - smtp:// off this machine refuses to send without STARTTLS;
 *   - SMTP without a sender, or a broken URL, stops the server at start.
 * A real provider is the manual test.
 *
 * Requires: the core's database (pnpm db:up), and the test account (_setup.mjs).
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';

const EMAIL = process.env.FABRIKKA_TEST_EMAIL ?? 'acceptance@example.com';
const SMTP_USER = 'm45-user';
const SMTP_PASS = 'p@ss/word';
const FROM = 'Fabrikka <hello@fabrikka.test>';

let failures = 0;
const check = (cond, m) => {
  if (cond) console.log('ok  ', m);
  else {
    console.error('FAIL', m);
    failures++;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------ a provider, in 40 lines */

const received = [];
const smtp = createServer((socket) => {
  const mail = { auth: null, from: null, to: [], data: '' };
  let inData = false;
  let buffer = '';
  const say = (line) => socket.write(`${line}\r\n`);
  say('220 m45 ESMTP');
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let at;
    while ((at = buffer.indexOf('\r\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 2);
      if (inData) {
        if (line === '.') {
          inData = false;
          received.push({ ...mail });
          say('250 queued');
        } else mail.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        continue;
      }
      const verb = line.split(' ')[0].toUpperCase();
      if (verb === 'EHLO') say('250-m45\r\n250 AUTH PLAIN LOGIN');
      else if (verb === 'HELO') say('250 m45');
      else if (verb === 'AUTH') {
        const [, , blob] = line.split(' ');
        const [, user, pass] = Buffer.from(blob ?? '', 'base64').toString('utf8').split('\0');
        mail.auth = { user, pass };
        say(user === SMTP_USER && pass === SMTP_PASS ? '235 ok' : '535 no');
      } else if (verb === 'MAIL') {
        mail.from = line.match(/<([^>]*)>/)?.[1];
        say('250 ok');
      } else if (verb === 'RCPT') {
        mail.to.push(line.match(/<([^>]*)>/)?.[1]);
        say('250 ok');
      } else if (verb === 'DATA') {
        inData = true;
        say('354 go');
      } else if (verb === 'QUIT') {
        say('221 bye');
        socket.end();
      } else say('250 ok');
    }
  });
  socket.on('error', () => {});
});
await new Promise((ok) => smtp.listen(0, '127.0.0.1', ok));
const smtpPort = smtp.address().port;
const enc = encodeURIComponent;

/* ------------------------------------------------ the core, configured like an operator would */

function startCore(port, env) {
  let out = '';
  const child = spawn('npx', ['tsx', '--env-file-if-exists=../../.env', 'src/index.ts'], {
    cwd: 'apps/server',
    env: { ...process.env, PORT: String(port), PUBLIC_URL: `http://localhost:${port}`, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const exited = new Promise((ok) => child.on('exit', (code) => ok(code)));
  return { child, exited, output: () => out };
}
async function upOrExit(core, port) {
  for (let i = 0; i < 60; i++) {
    if ((await fetch(`http://localhost:${port}/health`).catch(() => null))?.ok) return 'up';
    if (core.child.exitCode !== null) return 'exited';
    await sleep(500);
  }
  return 'timeout';
}

const PORT = 9345;
const url = `smtp://${enc(SMTP_USER)}:${enc(SMTP_PASS)}@127.0.0.1:${smtpPort}`;
const core = startCore(PORT, { FABRIKKA_MAIL: url, FABRIKKA_MAIL_FROM: FROM });
try {
  check((await upOrExit(core, PORT)) === 'up', 'the core starts with an SMTP transport');
  const options = await (await fetch(`http://localhost:${PORT}/api/auth/options`)).json();
  check(options.passwordReset === true, 'with SMTP configured, the login page offers Forgot password?');

  await fetch(`http://localhost:${PORT}/api/auth/password-reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
  for (let i = 0; i < 40 && !received.length; i++) await sleep(250);
  const mail = received.at(-1);
  check(!!mail, 'a password reset reaches the SMTP server');
  check(mail?.auth?.user === SMTP_USER && mail?.auth?.pass === SMTP_PASS, "it logs in with the URL's credentials, decoded (a password with @ and /)");
  check(mail?.from === 'hello@fabrikka.test' && /^From: Fabrikka <hello@fabrikka\.test>$/m.test(mail?.data ?? ''), 'it comes from FABRIKKA_MAIL_FROM');
  check(mail?.to.join() === EMAIL && /\/reset\/[A-Za-z0-9_-]+/.test(mail?.data.replace(/=\n/g, '') ?? ''), 'to the account, with its reset link');
  await sleep(300);
  check(core.output().includes(`SMTP to 127.0.0.1 is ready`), 'the start-up check says the connection works, naming the host');
  check(!core.output().includes(SMTP_PASS) && !core.output().includes(enc(SMTP_PASS)) && !core.output().includes(url), 'THE URL AND ITS PASSWORD NEVER REACH THE LOG');
} finally {
  core.child.kill();
  await core.exited;
}

/* ------------------------------------------------ no plain text off this machine */

// ::ffff:127.0.0.1 is this machine, but not a name the transport trusts as local,
// so it stands in for a remote provider that doesn't offer STARTTLS.
const remote = startCore(PORT + 1, { FABRIKKA_MAIL: `smtp://${enc(SMTP_USER)}:${enc(SMTP_PASS)}@[::ffff:127.0.0.1]:${smtpPort}`, FABRIKKA_MAIL_FROM: FROM });
try {
  check((await upOrExit(remote, PORT + 1)) === 'up', 'a provider that fails its check does not stop the server');
  const before = received.length;
  await fetch(`http://localhost:${PORT + 1}/api/auth/password-reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: EMAIL }) });
  await sleep(2500);
  check(received.length === before, 'SMTP OFF THIS MACHINE WITHOUT STARTTLS SENDS NOTHING (no credentials or mail in the clear)');
  check(/SMTP to .* (failed its check|could not send)/.test(remote.output()), '…and the log says why');
} finally {
  remote.child.kill();
  await remote.exited;
}

/* ------------------------------------------------ misconfiguration stops the start */

const noFrom = startCore(PORT + 2, { FABRIKKA_MAIL: url, FABRIKKA_MAIL_FROM: '' });
check((await upOrExit(noFrom, PORT + 2)) === 'exited' && /FABRIKKA_MAIL_FROM must name the sender/.test(noFrom.output()), 'SMTP WITHOUT A SENDER STOPS THE SERVER AT START, saying why');
noFrom.child.kill();
const broken = startCore(PORT + 3, { FABRIKKA_MAIL: 'smtp://', FABRIKKA_MAIL_FROM: FROM });
check((await upOrExit(broken, PORT + 3)) === 'exited', 'a broken SMTP URL stops the server at start');
broken.child.kill();

smtp.close();
if (failures) {
  console.error(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nM45 checks passed');
process.exit(0);
