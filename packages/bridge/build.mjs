/**
 * Bundle the bridge to a single executable file.
 *
 * A build rather than shipping TypeScript: `npx @fabrikka/bridge` has to work on
 * whatever Node the user has, and Node's type stripping only erases annotations —
 * it cannot transform TypeScript-only syntax, and it is Node 22.6+ only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { build, context } from 'esbuild';

/**
 * M33 (ADR 0030): the version every instance serves in its manifest, stamped into
 * the client too, so a host can tell it's out of date. A build is a release.
 */
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const VERSION = `${pkg.version}+${new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '')}`;

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
  // Everything is bundled, `ws` included (M33): the file an instance serves at
  // /downloads/fabrikka.mjs must run with nothing installed beside it. Only
  // ws's optional native add-ons stay out; ws loads them in try/catch and falls
  // back without them.
  external: ['bufferutil', 'utf-8-validate'],
  // ws is CommonJS and requires Node built-ins; an ESM bundle needs a real
  // `require` for that, or esbuild's shim throws "Dynamic require … not supported".
  banner: { js: "import { createRequire as __fabrikkaCreateRequire } from 'node:module';\nconst require = __fabrikkaCreateRequire(import.meta.url);" },
  define: { __FABRIKKA_VERSION__: JSON.stringify(VERSION) },
  logLevel: 'info',
};

if (process.argv.includes('--watch')) {
  const ctx = await context(options);
  await ctx.watch();
  console.error('[bridge] watching');
} else {
  await build(options);
  writeFileSync(new URL('./dist/version.json', import.meta.url), JSON.stringify({ version: VERSION }) + '\n');
  console.error(`[bridge] built ${VERSION}`);
}
