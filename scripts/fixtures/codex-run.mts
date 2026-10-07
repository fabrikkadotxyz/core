/**
 * M35 fixture: run Codex exactly as the host does — through the runner's own
 * runAgent — and print what happened as JSON. Used by scripts/acceptance/m35.mjs.
 *
 *   tsx codex-run.mts args                       → each policy's Codex flags
 *   tsx codex-run.mts run '<json SpawnRequest>'  → { ok, text, tools }
 */
import { codexPolicyArgs, runAgent, type Policy } from '../../packages/bridge/src/spawn.ts';

const [mode, json] = process.argv.slice(2);
if (mode === 'args') {
  const out: Record<string, string[]> = {};
  for (const p of ['read', 'edit', 'full'] as Policy[]) out[p] = codexPolicyArgs(p);
  console.log(JSON.stringify(out));
} else {
  const req = JSON.parse(json ?? '{}');
  const tools: string[] = [];
  const result = await runAgent({
    provider: 'codex',
    systemPreamble: '',
    ...req,
    onActivity: (a) => tools.push(String((a as { tool?: string }).tool ?? JSON.stringify(a))),
  });
  console.log(JSON.stringify({ ok: result.ok, text: result.text, error: result.error, tools }));
}
