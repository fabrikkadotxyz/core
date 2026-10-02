/**
 * Install the TeX assets the `latex` output kind needs. See ADR 0020 and
 * docs/operations.md.
 *
 * Everything a viewer's browser loads to compile LaTeX is served by this
 * instance from TEX_ASSETS_DIR — the engine, the core TeX tree it boots from,
 * and the full tree it fetches rare packages from — so no third party learns
 * which packages a document uses.
 *
 * The version is the pinned @typeward/texlive-wasm version: wrapper and assets
 * must match exactly, and the directory is versioned so assets can be cached
 * forever.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const PKG = join(ROOT, 'apps/web/node_modules/@typeward/texlive-wasm');
const { version } = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8'));
const BASE = resolve(process.env.TEX_ASSETS_DIR ?? join(ROOT, '.tex-assets'));
const DEST = join(BASE, version);

if (existsSync(join(DEST, 'ready.json'))) {
  console.log(`TeX assets ${version} already installed in ${DEST}`);
  process.exit(0);
}

mkdirSync(DEST, { recursive: true });
console.log(`Installing TeX assets ${version} into ${DEST} (about 360 MB)…`);

// The CLI verifies every download against the release's SHA-256 checksums.
execFileSync(
  process.execPath,
  [
    join(PKG, 'scripts/cli.cjs'),
    'download-assets',
    '--tag',
    `v${version}`,
    '--assets',
    'pdflatex-emscripten,bibtexu-emscripten,texmf-core-pdflatex,icudt78l.dat,texmf',
    DEST,
  ],
  { stdio: 'inherit' },
);

// The full tree is served file by file from texmf/; its archive is dead weight.
rmSync(join(DEST, 'texmf.tar.gz'), { force: true });

for (const required of [
  'pdflatex/emscripten/pdflatex.wasm',
  'bibtexu/emscripten/bibtexu.wasm',
  'texmf-core-pdflatex.tar.gz',
  'icudt78l.dat',
  'texmf/ls-R',
]) {
  if (!existsSync(join(DEST, required))) {
    console.error(`missing after install: ${required}`);
    process.exit(1);
  }
}

writeFileSync(join(DEST, 'ready.json'), JSON.stringify({ version, installedAt: new Date().toISOString() }));
console.log('TeX assets ready. Restart the server to offer LaTeX outputs.');
