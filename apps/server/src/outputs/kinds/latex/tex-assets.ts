/**
 * TeX assets for the `latex` output kind. See ADR 0020.
 *
 * The server never runs TeX. It only serves the WebAssembly engine and the TeX
 * Live tree that viewers' browsers compile with, so no third party learns which
 * packages a document uses. Installed by `pnpm tex:install`.
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';

const BASE = resolve(
  process.env.TEX_ASSETS_DIR ?? join(import.meta.dirname, '..', '..', '..', '..', '..', '..', '.tex-assets'),
);

/** The installed version directory, or null. Checked once: install, then restart. */
const VERSION: string | null = (() => {
  if (!existsSync(BASE)) return null;
  const ready = readdirSync(BASE)
    .filter((v) => existsSync(join(BASE, v, 'ready.json')))
    .sort();
  return ready.at(-1) ?? null;
})();

export function texAvailable(): boolean {
  return VERSION !== null;
}

/** Where the browser finds the assets — versioned, so they can be cached forever. */
export function texAssetsPath(): string | null {
  return VERSION ? `/tex-assets/${VERSION}` : null;
}

const TYPES: Record<string, string> = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.dat': 'application/octet-stream',
};

/**
 * Serve one asset, raw.
 *
 * Deliberately NOT content-encoded: the engine fetches `.tar.gz` bundles and
 * unpacks them itself, and a server that adds `Content-Encoding: gzip` makes the
 * browser decompress them first — which is how one candidate engine failed when
 * tested under a dev server.
 */
export function serveTexAsset(path: string): Response {
  if (!VERSION) return new Response('not found', { status: 404 });
  // `path` is everything after /tex-assets/. Resolve and refuse anything that
  // escapes the assets directory.
  const target = resolve(BASE, decodeURIComponent(path));
  if (!target.startsWith(BASE + sep)) return new Response('not found', { status: 404 });

  let size: number;
  try {
    const st = statSync(target);
    if (!st.isFile()) return new Response('not found', { status: 404 });
    size = st.size;
  } catch {
    return new Response('not found', { status: 404 });
  }

  return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, {
    headers: {
      'Content-Type': TYPES[extname(target)] ?? 'application/octet-stream',
      'Content-Length': String(size),
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
