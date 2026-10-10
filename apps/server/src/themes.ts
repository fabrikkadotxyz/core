/**
 * Themes (M44, ADR 0038): folders of CSS with no code, checked once at start.
 *
 * Each pack is `theme.json` + `theme.css`, plus optional fonts and images. A
 * pack that breaks a rule is skipped with a logged reason (docs/themes.md, "What
 * the server refuses"). Only files accepted here are ever served, so nothing
 * added later, and no `..` path, is reachable.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

export const THEME_CONTRACT = 1;
export const DEFAULT_THEME = 'dusk';
/** What *Match my system* resolves to. */
export const SYSTEM_THEMES = { light: 'dusk', dark: 'dusk-night' } as const;

const ID = /^[a-z0-9-]{1,40}$/;
const HEX = /^#[0-9a-fA-F]{6}$/;
const MAX_CSS = 256 * 1024;
const MAX_ASSET = 2 * 1024 * 1024;
const TYPES: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const FORBIDDEN = [/@import/i, /expression\s*\(/i, /javascript\s*:/i, /-moz-binding/i, /behavior\s*:/i, /image-set\s*\(/i];

export interface ThemeManifest {
  contract: number;
  id: string;
  name: string;
  description: string;
  author: string | null;
  license: string | null;
  scheme: 'light' | 'dark';
  swatches: string[];
}

export interface Theme extends ThemeManifest {
  builtIn: boolean;
  /** Published path (relative to the pack) → absolute file, for what passed the check. */
  files: Map<string, string>;
}

export class ThemeError extends Error {}

const text = (v: unknown, max: number, field: string, optional = false): string | null => {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new ThemeError(`${field} is required`);
  }
  if (typeof v !== 'string' || v.length > max) throw new ThemeError(`${field} must be text of at most ${max} characters`);
  return v;
};

export function parseManifest(raw: unknown): ThemeManifest {
  if (!raw || typeof raw !== 'object') throw new ThemeError('theme.json is not an object');
  const m = raw as Record<string, unknown>;
  if (m.contract !== THEME_CONTRACT) throw new ThemeError(`contract ${String(m.contract)} isn't supported (this server supports ${THEME_CONTRACT})`);
  if (typeof m.id !== 'string' || !ID.test(m.id)) throw new ThemeError('id must be 1–40 characters of a-z, 0-9 and -');
  if (m.scheme !== 'light' && m.scheme !== 'dark') throw new ThemeError('scheme must be "light" or "dark"');
  const swatches = m.swatches;
  if (!Array.isArray(swatches) || swatches.length < 2 || swatches.length > 6 || !swatches.every((s) => typeof s === 'string' && HEX.test(s))) {
    throw new ThemeError('swatches must be 2–6 colours like "#13121a"');
  }
  return {
    contract: THEME_CONTRACT,
    id: m.id,
    name: text(m.name, 40, 'name')!,
    description: text(m.description, 200, 'description')!,
    author: text(m.author, 100, 'author', true),
    license: text(m.license, 100, 'license', true),
    scheme: m.scheme,
    swatches: swatches as string[],
  };
}

/** Every `url(...)` must be a relative path that stays inside the pack. */
export function checkCss(css: string, packFiles: Set<string>): void {
  if (Buffer.byteLength(css) > MAX_CSS) throw new ThemeError('theme.css is over 256 KB');
  // Escapes can spell url( or @import without the letters (`\\75rl(`), so a theme
  // may not use any. Write the character itself instead: content: '—', not '\\2014'.
  if (css.includes('\\')) throw new ThemeError('theme.css contains a backslash escape; write the character itself');
  for (const re of FORBIDDEN) if (re.test(css)) throw new ThemeError(`theme.css contains ${re.source.replace(/\\s\*|\\/g, '')}, which themes may not use`);
  // Comments can't hide a url() from the browser, but they can hide one from us: strip them first.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const match of bare.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const target = (match[2] ?? '').trim();
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('/') || target.includes('\\')) {
      throw new ThemeError(`url(${target}) points outside the theme; only relative paths inside its folder are allowed`);
    }
    const path = target.replace(/^\.\//, '').split(/[?#]/)[0] ?? '';
    if (path.split('/').includes('..') || !packFiles.has(path)) throw new ThemeError(`url(${target}) isn't a file in the theme`);
  }
}

function walk(dir: string, root: string, out: Map<string, string>): void {
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    const rel = relative(root, abs).split(sep).join('/');
    if (st.isDirectory()) {
      walk(abs, root, out);
      continue;
    }
    const ext = extname(name).toLowerCase();
    if (!TYPES[ext]) throw new ThemeError(`${rel}: ${ext || 'this kind of file'} isn't allowed in a theme`);
    if (ext !== '.css' && ext !== '.json' && st.size > MAX_ASSET) throw new ThemeError(`${rel} is over 2 MB`);
    out.set(rel, abs);
  }
}

/** Read and check one pack. Throws ThemeError with the reason it's refused. */
export function loadPack(dir: string, builtIn: boolean): Theme {
  const files = new Map<string, string>();
  walk(dir, dir, files);
  if (!files.has('theme.json')) throw new ThemeError('no theme.json');
  if (!files.has('theme.css')) throw new ThemeError('no theme.css');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(files.get('theme.json')!, 'utf8'));
  } catch {
    throw new ThemeError('theme.json is not valid JSON');
  }
  const manifest = parseManifest(raw);
  checkCss(readFileSync(files.get('theme.css')!, 'utf8'), new Set(files.keys()));
  return { ...manifest, builtIn, files };
}

/** The built-in themes, then the instance's own. Logs what it offers and skips. */
export function loadThemes(dirs: { dir: string; builtIn: boolean }[], log = console): Map<string, Theme> {
  const themes = new Map<string, Theme>();
  for (const { dir, builtIn } of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort(builtInOrder)) {
      const pack = join(dir, name);
      if (name.startsWith('.') || !statSync(pack).isDirectory()) continue;
      try {
        const theme = loadPack(pack, builtIn);
        if (themes.has(theme.id)) throw new ThemeError(`id "${theme.id}" is already taken`);
        themes.set(theme.id, theme);
      } catch (err) {
        log.warn(`[themes] skipped ${pack}: ${(err as Error).message}`);
      }
    }
  }
  if (themes.size) log.log(`[themes] offering ${[...themes.keys()].join(', ')}`);
  return themes;
}

/** Built-ins in the order the picker shows them; anything else alphabetically after. */
const ORDER = ['dusk', 'dusk-night', 'terminal', 'paper', 'brutal', 'aurora'];
function builtInOrder(a: string, b: string): number {
  const ia = ORDER.indexOf(a);
  const ib = ORDER.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? ORDER.length : ia) - (ib === -1 ? ORDER.length : ib);
  return a.localeCompare(b);
}

/** A file of a theme, if the check accepted it: its path and content type. */
export function themeFile(themes: Map<string, Theme>, id: string, path: string): { abs: string; type: string } | null {
  const abs = themes.get(id)?.files.get(path);
  const type = abs && TYPES[extname(abs).toLowerCase()];
  if (!abs || !type) return null;
  return { abs, type };
}

/** Where themes come from: the repository's `themes/`, then FABRIKKA_THEMES_DIR. */
export function themeDirs(): { dir: string; builtIn: boolean }[] {
  const dirs = [{ dir: resolve(import.meta.dirname, '../../../themes'), builtIn: true }];
  const own = process.env.FABRIKKA_THEMES_DIR?.trim() || (process.env.FABRIKKA_DATA_DIR ? join(process.env.FABRIKKA_DATA_DIR, 'themes') : '');
  if (own) dirs.push({ dir: resolve(own), builtIn: false });
  return dirs;
}

/** What `GET /api/themes` returns for one theme. */
export function publicTheme(t: Theme) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    author: t.author,
    license: t.license,
    scheme: t.scheme,
    swatches: t.swatches,
    builtIn: t.builtIn,
  };
}
