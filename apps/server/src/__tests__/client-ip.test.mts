/** The client's address behind proxies (docs/operations.md, "Behind a proxy"). */
import { parseTrustedProxies, pickClientIp } from '../client-ip.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};
const refuses = (label: string, fn: () => unknown) => {
  try { fn(); ok(label, false); } catch { ok(label, true); }
};

ok('no proxy: the socket, whatever the header says', pickClientIp('203.0.113.7', '1.2.3.4', 0) === '203.0.113.7');
ok('one proxy: the address it saw', pickClientIp('10.0.0.2', '198.51.100.9', 1) === '198.51.100.9');
ok('ONE PROXY: A FORGED ENTRY ON THE LEFT IS IGNORED', pickClientIp('10.0.0.2', '6.6.6.6, 198.51.100.9', 1) === '198.51.100.9');
ok('two proxies (Cloudflare, then the platform)', pickClientIp('10.0.0.2', '6.6.6.6, 198.51.100.9, 172.64.0.1', 2) === '198.51.100.9');
ok('a request that skipped the proxy: never further left than the header goes', pickClientIp('198.51.100.9', undefined, 1) === '198.51.100.9');
ok('spaces and empty entries are tolerated', pickClientIp('10.0.0.2', ' , 198.51.100.9 ,', 1) === '198.51.100.9');
ok('unset means 0', parseTrustedProxies(undefined) === 0 && parseTrustedProxies('') === 0);
ok('a number is read', parseTrustedProxies('2') === 2);
refuses('a word is refused at start', () => parseTrustedProxies('yes'));
refuses('an absurd count is refused at start', () => parseTrustedProxies('99'));

if (fails) process.exit(1);
