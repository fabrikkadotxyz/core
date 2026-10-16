/**
 * M16 fixture: run Antigravity exactly as the host does — through the runner's
 * own runAgent — and print what happened as JSON. Used by
 * scripts/acceptance/m16-antigravity.mjs.
 *
 *   tsx antigravity-run.mts args                      → each policy's agy flags
 *   tsx antigravity-run.mts run '<json SpawnRequest>' → { ok, text, error, tools }
 */
import { antigravityPolicyArgs, runAgent, type Policy } from '../../packages/bridge/src/spawn.ts';

const [mode, json] = process.argv.slice(2);
if (mode === 'args') {
  const out: Record<string, string[]> = {};
  for (const p of ['read', 'edit', 'full'] as Policy[]) out[p] = antigravityPolicyArgs(p);
  console.log(JSON.stringify(out));
} else if (mode === 'run') {
  const req = JSON.parse(json ?? '{}') as Parameters<typeof runAgent>[0];
  const tools: string[] = [];
  const result = await runAgent({ ...req, provider: 'antigravity', onActivity: (a) => tools.push(a.tool), onLog: () => {} });
  console.log(JSON.stringify({ ok: result.ok, text: result.text, error: result.error ?? null, resumeId: result.resumeId ?? null, tools }));
} else {
  console.error('usage: antigravity-run.mts args | run <json>');
  process.exit(2);
}
