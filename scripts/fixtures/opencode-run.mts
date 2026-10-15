/**
 * M16 fixture: run OpenCode exactly as the host does — through the runner's own
 * runAgent — and print what happened as JSON. Used by scripts/acceptance/m16.mjs.
 *
 *   tsx opencode-run.mts config                     → each policy's OpenCode config and flags
 *   tsx opencode-run.mts run '<json SpawnRequest>'  → { ok, text, error, tools }
 */
import { opencodePolicyArgs, opencodePolicyConfig, runAgent, type Policy } from '../../packages/bridge/src/spawn.ts';

const [mode, json] = process.argv.slice(2);
if (mode === 'config') {
  const out: Record<string, { config: Record<string, unknown>; args: string[] }> = {};
  for (const p of ['read', 'edit', 'full'] as Policy[]) {
    out[p] = { config: opencodePolicyConfig(p, { url: 'https://example.test/mcp' }), args: opencodePolicyArgs(p) };
  }
  console.log(JSON.stringify(out));
} else {
  const req = JSON.parse(json ?? '{}');
  const tools: string[] = [];
  const result = await runAgent({
    provider: 'opencode',
    systemPreamble: '',
    ...req,
    onActivity: (a) => tools.push(String((a as { tool?: string }).tool ?? JSON.stringify(a))),
  });
  console.log(JSON.stringify({ ok: result.ok, text: result.text, error: result.error, resumeId: result.resumeId, tools }));
}
