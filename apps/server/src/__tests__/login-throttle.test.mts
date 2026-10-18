/** Guessing passwords (M59, docs/security.md): failures count, successes don't, windows pass. */
import { createLoginThrottle, LOGIN_MAX_PER_CLIENT, LOGIN_MAX_PER_EMAIL, LOGIN_WINDOW_MS } from '../login-throttle.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};

let t = 1_000_000;
const th = createLoginThrottle(() => t);

ok('a fresh address may try', th.allowed('a@example.com', '10.0.0.1'));
for (let i = 0; i < LOGIN_MAX_PER_EMAIL - 1; i++) th.failed('a@example.com', '10.0.0.1');
ok(`${LOGIN_MAX_PER_EMAIL - 1} failures: still allowed`, th.allowed('a@example.com', '10.0.0.1'));
th.failed('a@example.com', '10.0.0.1');
ok(`THE ${LOGIN_MAX_PER_EMAIL}TH FAILURE LOCKS THE ADDRESS`, !th.allowed('a@example.com', '10.0.0.1'));
ok('…in any letter case', !th.allowed('A@Example.com ', '10.0.0.1'));
ok('…from any client', !th.allowed('a@example.com', '10.0.0.2'));
ok('another address from the same client is fine', th.allowed('b@example.com', '10.0.0.1'));
ok('the operator can see the count', th.failuresFor('a@example.com') === LOGIN_MAX_PER_EMAIL);

t += LOGIN_WINDOW_MS - 1;
ok('a moment before the window ends: still locked', !th.allowed('a@example.com', '10.0.0.1'));
t += 2;
ok('THE WINDOW PASSES: allowed again, count gone', th.allowed('a@example.com', '10.0.0.1') && th.failuresFor('a@example.com') === 0);

// The client limit: many addresses, one guesser.
const th2 = createLoginThrottle(() => t);
for (let i = 0; i < LOGIN_MAX_PER_CLIENT; i++) th2.failed(`u${i}@example.com`, '203.0.113.9');
ok(`${LOGIN_MAX_PER_CLIENT} failures across addresses lock the client`, !th2.allowed('fresh@example.com', '203.0.113.9'));
ok('…and not another client', th2.allowed('fresh@example.com', '203.0.113.10'));

// Successes cost nothing: allowed() never counts.
const th3 = createLoginThrottle(() => t);
for (let i = 0; i < 1000; i++) th3.allowed('busy@example.com', '10.0.0.1');
ok('a thousand allowed checks lock nothing', th3.allowed('busy@example.com', '10.0.0.1') && th3.failuresFor('busy@example.com') === 0);

if (fails) process.exit(1);
