/**
 * Bundle the bridge to a single executable file.
 *
 * A build rather than shipping TypeScript: `npx @fabrikka/bridge` has to work on
 * whatever Node the user has, and Node's type stripping only erases annotations —
 * it cannot transform TypeScript-only syntax, and it is Node 22.6+ only.
 */
import { build, context } from 'esbuild';

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/cli.js',
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  sourcemap: true,
  // No shebang banner: esbuild preserves the one on src/cli.ts, and adding it
  // here produces two, which is a syntax error.
  // Bundling the SDKs keeps the published artifact self-contained, so a user
  // running npx never sees a version-resolution problem. `ws` has optional
  // native deps it loads lazily, so it stays external.
  external: ['ws', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('[bridge] watching');
} else {
  await build(options);
}
