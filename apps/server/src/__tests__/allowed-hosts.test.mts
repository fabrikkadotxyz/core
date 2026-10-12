/** The hostnames the server answers to (docs/operations.md). */
import { allowedHostsFor } from '../mcp.ts';

let fails = 0;
const ok = (label: string, cond: boolean) => {
  if (cond) console.log('ok  ', label);
  else { console.error('FAIL', label); fails++; }
};

ok('development (localhost, no list): the adapter keeps its own localhost protection', allowedHostsFor('http://localhost:9090', undefined) === undefined);
const deployed = allowedHostsFor('https://app.fabrikka.xyz', undefined)!;
ok("A DEPLOYED INSTANCE ANSWERS TO ITS PUBLIC_URL'S HOST", deployed.includes('app.fabrikka.xyz'));
ok('…and localhost, for its own health check', deployed.includes('localhost') && deployed.includes('127.0.0.1'));
ok('…and nothing else', !deployed.includes('example-app.fly.dev'));
const fly = allowedHostsFor('https://app.fabrikka.xyz', 'example-app.fly.dev, Other.Example ')!;
ok("the platform's address and listed names are added, trimmed and lower-cased", fly.includes('example-app.fly.dev') && fly.includes('other.example'));
ok('a list on localhost still turns the list on', allowedHostsFor('http://localhost:9090', 'tunnel.example')?.includes('tunnel.example') === true);

if (fails) process.exit(1);
