import { redact, summarise } from '../redact.ts';
import { codexActivity, opencodeActivity } from '../spawn.ts';

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

/* --- shell wrappers: Codex runs everything through a login shell --- */
eq('zsh -lc is unwrapped', summarise({ name: 'Bash', args: { command: "/bin/zsh -lc 'pytest -q'" } }), { tool: 'Bash', detail: 'pytest' });
eq('bash -c is unwrapped', summarise({ name: 'Bash', args: { command: 'bash -c "npm test"' } }), { tool: 'Bash', detail: 'npm' });
eq('sh -c is unwrapped', summarise({ name: 'Bash', args: { command: "sh -c 'ls -la'" } }), { tool: 'Bash', detail: 'ls' });
const wrapped = summarise({ name: 'Bash', args: { command: `/bin/zsh -lc 'curl -H "Authorization: Bearer sk-ant-api03-SECRETVALUE" https://api.example.com'` } });
eq('wrapped command still shows only the program', wrapped, { tool: 'Bash', detail: 'curl' });
lacks('a wrapper does not smuggle the token through', JSON.stringify(wrapped), 'SECRETVALUE');
eq('a bare shell is left alone', summarise({ name: 'Bash', args: { command: '/bin/zsh' } }), { tool: 'Bash', detail: '/bin/zsh' });
eq('ssh is not mistaken for a shell wrapper', summarise({ name: 'Bash', args: { command: 'ssh -c aes256 host' } }), { tool: 'Bash', detail: 'ssh' });

/* --- Codex's event stream, from lines captured off codex-cli 0.158.0 --- */
const codexShellStarted = '{"type":"item.started","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'cat ANSWER.txt\'","aggregated_output":"","exit_code":null,"status":"in_progress"}}';
const codexShellCompleted = '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"/bin/zsh -lc \'cat ANSWER.txt\'","aggregated_output":"the magic number is 8471\\n","exit_code":0,"status":"completed"}}';

eq('codex reports a shell step once, on started', codexActivity(codexShellStarted), { tool: 'Bash', detail: 'cat' });
eq('codex ignores the completed twin, so no step appears twice', codexActivity(codexShellCompleted), null);
lacks('codex never carries aggregated_output', JSON.stringify(codexActivity(codexShellStarted)), '8471');
eq('codex mcp call is namespaced', codexActivity('{"type":"item.started","item":{"id":"item_1","type":"mcp_tool_call","server":"fabrikka_session","tool":"post_message","arguments":{"content":"done"}}}'), { tool: 'fabrikka_session__post_message', detail: null });
eq('codex thread events are not activity', codexActivity('{"type":"thread.started","thread_id":"t_1"}'), null);
eq('codex agent_message is not activity', codexActivity('{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"the number is 8471"}}'), null);
eq('a non-JSON line is ignored', codexActivity('Reading additional input from stdin...'), null);
eq('malformed JSON is ignored', codexActivity('{"type":"item.started"'), null);

// OpenCode (ADR 0047): one tool_use event per call; part.state.output is never read.
const opencodeRead = '{"type":"tool_use","timestamp":1,"sessionID":"ses_1","part":{"type":"tool","tool":"read","callID":"c1","state":{"status":"completed","input":{"filePath":"/work/note.txt"},"output":"<content>\\nthe number is 8471\\n</content>"}}}';
eq('opencode reports a read step with its path', opencodeActivity(opencodeRead), { tool: 'Read', detail: '/work/note.txt' });
lacks('opencode never carries the tool output', JSON.stringify(opencodeActivity(opencodeRead)), '8471');
eq('opencode shell steps keep the program only', opencodeActivity('{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"status":"completed","input":{"command":"curl -H \\"Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz\\" https://x"}}}}'), { tool: 'Bash', detail: 'curl' });
eq('opencode edits name the file', opencodeActivity('{"type":"tool_use","part":{"type":"tool","tool":"edit","state":{"status":"completed","input":{"filePath":"/work/typo.txt","oldString":"teh","newString":"the"}}}}'), { tool: 'Edit', detail: '/work/typo.txt' });
eq('opencode mcp tools arrive under their server prefix, name only', opencodeActivity('{"type":"tool_use","part":{"type":"tool","tool":"fabrikka_session_post_message","state":{"status":"completed","input":{"content":"done"}}}}'), { tool: 'fabrikka_session_post_message', detail: null });
eq('opencode text events are not activity', opencodeActivity('{"type":"text","part":{"type":"text","text":"4242"}}'), null);
eq('opencode step events are not activity', opencodeActivity('{"type":"step_finish","part":{"type":"step-finish","reason":"stop"}}'), null);
eq('opencode malformed JSON is ignored', opencodeActivity('{"type":"tool_use"'), null);

console.log(fails === 0 ? '\nredaction: PASS' : `\nredaction: ${fails} FAILURE(S)`);
process.exit(fails === 0 ? 0 : 1);
