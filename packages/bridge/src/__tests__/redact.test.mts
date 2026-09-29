import { redact, summarise } from '../redact.ts';

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok  ', label);
  else { console.error('FAIL', label, '\n  got ', g, '\n  want', w); fails++; }
};
const has = (label: string, got: string, needle: string) => {
  if (got.includes(needle)) console.log('ok  ', label);
  else { console.error('FAIL', label, '| wanted to contain', needle); fails++; }
};
const lacks = (label: string, got: string, needle: string) => {
  if (!got.includes(needle)) console.log('ok  ', label);
  else { console.error('FAIL', label, '| LEAKED', needle, 'in', got); fails++; }
};

/* --- the cases that matter: secrets must not survive --- */
lacks('anthropic key redacted', redact('use sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'), 'sk-ant');
lacks('github pat redacted', redact('ghp_AbCdEfGhIjKlMnOpQrStUvWxYz012345'), 'ghp_');
lacks('github_pat redacted', redact('github_pat_11ABCDEFG0aBcDeFgHiJkLmNoP'), 'github_pat_');
lacks('slack token redacted', redact('xoxb-123456789012-abcdefghijkl'), 'xoxb-');
lacks('aws key id redacted', redact('AKIAIOSFODNN7EXAMPLE'), 'AKIA');
lacks('google api key redacted', redact('AIzaSyD-abcdefghijklmnopqrstuvwxyz12345'), 'AIza');
lacks('jwt redacted', redact('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk'), 'eyJhbGci');
lacks('bearer header redacted', redact('Authorization: Bearer abcdef1234567890'), 'abcdef1234567890');
lacks('password= redacted', redact('password=hunter2hunter2'), 'hunter2');
lacks('long hex redacted', redact('a'.repeat(64)), 'a'.repeat(64));
has('redaction leaves a marker', redact('sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv'), '[redacted]');
eq('ordinary text untouched', redact('read src/retry.ts'), 'read src/retry.ts');

/* --- Bash: program name only, never the command line --- */
let line = summarise({ name: 'Bash', args: { command: 'curl -H "Authorization: Bearer sk-ant-api03-SECRETVALUE" https://api.example.com' } });
eq('Bash shows only the program', line, { tool: 'Bash', detail: 'curl' });
lacks('Bash never leaks the token', JSON.stringify(line), 'SECRETVALUE');
lacks('Bash never leaks the URL', JSON.stringify(line), 'api.example.com');

eq('Bash program with flags', summarise({ name: 'Bash', args: { command: 'npm test -- --watch' } }), { tool: 'Bash', detail: 'npm' });
eq('Bash pipeline shows first program', summarise({ name: 'Bash', args: { command: 'cat /etc/passwd | grep root' } }), { tool: 'Bash', detail: 'cat' });

/* --- file tools: the path is the useful part --- */
eq('Read shows the path', summarise({ name: 'Read', args: { file_path: 'src/retry.ts' } }), { tool: 'Read', detail: 'src/retry.ts' });
eq('Edit shows the path', summarise({ name: 'Edit', args: { file_path: 'a/b/c.ts' } }), { tool: 'Edit', detail: 'a/b/c.ts' });
eq('Grep shows the pattern', summarise({ name: 'Grep', args: { pattern: 'TODO' } }), { tool: 'Grep', detail: 'TODO' });

/* --- URLs: host only --- */
eq('WebFetch shows host only', summarise({ name: 'WebFetch', args: { url: 'https://api.example.com/v1/secret?token=abc123def456' } }), { tool: 'WebFetch', detail: 'api.example.com' });
lacks('WebFetch never leaks the query', JSON.stringify(summarise({ name: 'WebFetch', args: { url: 'https://x.com/p?token=abc123def456' } })), 'abc123def456');

/* --- unknown tools get a name and nothing else --- */
eq('aggregated tool: name only', summarise({ name: 'github__create_issue', args: { title: 'secret project codename' } }), { tool: 'github__create_issue', detail: null });
eq('unknown tool: name only', summarise({ name: 'SomeFutureTool', args: { anything: 'sensitive' } }), { tool: 'SomeFutureTool', detail: null });

/* --- truncation and missing args --- */
const long = summarise({ name: 'Read', args: { file_path: '/very/deep/' + 'x'.repeat(200) + '.ts' } });
eq('long detail is truncated', (long.detail ?? '').length <= 80, true);
eq('Read with no args', summarise({ name: 'Read' }), { tool: 'Read', detail: null });
eq('Bash with no command', summarise({ name: 'Bash', args: {} }), { tool: 'Bash', detail: null });

console.log(fails === 0 ? '\nredaction: PASS' : `\nredaction: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
