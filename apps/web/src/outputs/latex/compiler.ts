/**
 * Compile a LaTeX output in this browser. See ADR 0020.
 *
 * The TeX engine is Typeward's texlive-wasm, pinned exactly, and only its
 * `createEngine` / `run` are used: the passes (pdfLaTeX → BibTeX → pdfLaTeX) and
 * the long-tail fetch are driven here, because its own `latexmk` and lazy fetch
 * were found not to work when tested. This file is the whole surface we would
 * replace if the engine had to change.
 *
 * Everything is fetched from this instance's /tex-assets/. Nothing is sent
 * anywhere else, and nothing here runs on the server.
 */
import { createEngine, type EngineHandle, type FileInput, type RunResult } from '@typeward/texlive-wasm';
import type { BuildError } from '@fabrikka/types';

/** A runaway document stalls its own preview for this long, then is killed. */
const RUN_TIMEOUT_MS = 20_000;
const MAX_TEX_PASSES = 3;
const MAX_TAIL_FETCHES = 12;

export interface CompileResult {
  ok: boolean;
  pdf: Uint8Array | null;
  /** Gzipped SyncTeX, for mapping source lines to PDF positions. */
  synctex: Uint8Array | null;
  errors: BuildError[];
  /** The source this result is for — reported to the server as-is. */
  sourceHash: string;
  ms: number;
}

/** What TeX and BibTeX say when they cannot find a file. */
const MISSING = [
  /File [`']([^']+)' not found/g,
  /I couldn't open style file ([\w.-]+)/g,
  /I can't find file `([^']+)'/g,
];

export class LatexCompiler {
  private tex: Promise<EngineHandle> | null = null;
  private bibtex: Promise<EngineHandle> | null = null;
  private index: Promise<Map<string, string>> | null = null;
  /** Long-tail files fetched so far, by file name. Kept across compiles. */
  private tail = new Map<string, Uint8Array>();
  /** Reused while the citations and the .bib files have not changed. */
  private lastBib: { key: string; bbl: Uint8Array } | null = null;
  /** The previous .aux, so cross-references resolve in one pass while typing. */
  private lastAux: Uint8Array | null = null;

  constructor(private readonly base: string) {}

  private config(id: 'pdflatex' | 'bibtexu') {
    return {
      enginePath: `${this.base}/${id}/emscripten/${id}.wasm`,
      bundleUrl: `${this.base}/texmf-core-pdflatex.tar.gz`,
      icuDataUrl: `${this.base}/icudt78l.dat`,
      // Assets come from this instance, which installed them from the pinned,
      // checksummed release (scripts/tex-install.mjs).
      allowUnverifiedAssets: true,
      verbose: 'silent' as const,
    };
  }

  /** Start downloading the engine before the first compile is needed. */
  warm(): void {
    this.tex ??= createEngine('pdflatex', this.config('pdflatex'));
  }

  async compile(sources: Map<string, string>, assets: Map<string, Uint8Array>, mainFile: string): Promise<CompileResult> {
    const started = performance.now();
    const sourceHash = await hashSources(sources);
    const job = mainFile.replace(/\.tex$/, '');
    const files: FileInput[] = [
      ...[...sources].map(([path, content]) => ({ path, content })),
      ...[...assets].map(([path, content]) => ({ path, content })),
    ];

    try {
      this.tex ??= createEngine('pdflatex', this.config('pdflatex'));
      const tex = await this.tex;
      const args = ['-interaction=nonstopmode', '-halt-on-error', '-file-line-error', '-synctex=1', mainFile];
      const extra = (): FileInput[] => [
        ...(this.lastAux ? [{ path: `${job}.aux`, content: this.lastAux }] : []),
        ...(this.lastBib ? [{ path: `${job}.bbl`, content: this.lastBib.bbl }] : []),
      ];

      let run = await this.withTail(tex, args, [...files, ...extra()]);
      if (run.exitCode !== 0 && (this.lastAux || this.lastBib)) {
        // A stale .aux or .bbl from an earlier version can itself be the error.
        // Try once from clean before blaming the document.
        this.lastAux = null;
        this.lastBib = null;
        run = await this.withTail(tex, args, files);
      }
      for (let pass = 1; pass < MAX_TEX_PASSES && run.exitCode === 0; pass++) {
        const aux = run.outputs.get(`${job}.aux`) ?? null;
        let bblChanged = false;
        if (aux) {
          const auxText = new TextDecoder().decode(aux);
          if (/\\bibdata\{/.test(auxText)) {
            // Re-run BibTeX only when what it reads changed: the citations and
            // style in the .aux, or a .bib file.
            const bibs = [...sources].filter(([p]) => p.endsWith('.bib')).map(([p, t]) => `${p}\n${t}`);
            const key = auxText.split('\n').filter((l) => /^\\(citation|bibdata|bibstyle)/.test(l)).join('\n') + bibs.join('\n');
            if (this.lastBib?.key !== key) {
              this.bibtex ??= createEngine('bibtexu', this.config('bibtexu'));
              const b = await this.withTail(await this.bibtex, [job], [...files, { path: `${job}.aux`, content: aux }]);
              const bbl = b.outputs.get(`${job}.bbl`);
              if (bbl) {
                this.lastBib = { key, bbl };
                bblChanged = true;
              }
            }
          }
          this.lastAux = aux;
        }
        const log = run.log;
        const rerun = bblChanged || /Rerun to get|Label\(s\) may have changed|There were undefined references/.test(log);
        if (!rerun) break;
        run = await this.withTail(tex, args, [...files, ...extra()]);
      }

      const pdf = run.outputs.get(`${job}.pdf`) ?? null;
      return {
        ok: run.exitCode === 0 && !!pdf,
        pdf,
        synctex: run.outputs.get(`${job}.synctex.gz`) ?? null,
        errors: run.exitCode === 0 ? [] : parseErrors(run.log, mainFile),
        sourceHash,
        ms: performance.now() - started,
      };
    } catch (err) {
      // A timeout terminates the engine's worker; start fresh next time.
      void this.dispose();
      const message = /timeout/i.test(String(err))
        ? `Stopped after ${RUN_TIMEOUT_MS / 1000} s — the document may loop forever.`
        : `The compiler failed: ${(err as Error).message}`;
      return { ok: false, pdf: null, synctex: null, errors: [{ file: mainFile, line: null, message }], sourceHash, ms: performance.now() - started };
    }
  }

  /**
   * Run, and when TeX reports a missing file, fetch it from this instance's full
   * TeX tree and run again. Fetched files go in the project directory, which TeX
   * searches first.
   */
  private async withTail(engine: EngineHandle, args: string[], files: FileInput[]): Promise<RunResult> {
    for (let i = 0; ; i++) {
      const all = [...files, ...[...this.tail].map(([path, content]) => ({ path, content }))];
      const r = await engine.run({ args, files: all, lazyFetch: false, timeoutMs: RUN_TIMEOUT_MS });
      if (r.exitCode === 0 || i >= MAX_TAIL_FETCHES) return r;

      const text = `${r.log}\n${r.stdout}`;
      const names = new Set<string>();
      for (const re of MISSING) for (const m of text.matchAll(re)) names.add(m[1]!);
      const index = await (this.index ??= this.loadIndex());
      const wanted = [...names]
        .map((n) => index.get(n) ?? index.get(`${n}.tex`) ?? index.get(`${n}.sty`))
        .filter((p): p is string => !!p && !this.tail.has(p.split('/').pop()!));
      if (wanted.length === 0) return r;

      for (const path of wanted) {
        const res = await fetch(`${this.base}/texmf/${path}`);
        if (res.ok) this.tail.set(path.split('/').pop()!, new Uint8Array(await res.arrayBuffer()));
      }
    }
  }

  /** File name → path in the TeX tree, from kpathsea's own ls-R database. */
  private async loadIndex(): Promise<Map<string, string>> {
    const text = await (await fetch(`${this.base}/texmf/ls-R`)).text();
    const index = new Map<string, string>();
    let dir = '';
    for (const line of text.split('\n')) {
      if (line.endsWith(':')) {
        dir = line.slice(0, -1).replace(/^\.\/?/, '');
        continue;
      }
      if (line && !line.startsWith('%') && !index.has(line)) index.set(line, dir ? `${dir}/${line}` : line);
    }
    return index;
  }

  async dispose(): Promise<void> {
    const engines = [this.tex, this.bibtex];
    this.tex = this.bibtex = null;
    for (const e of engines) await e?.then((h) => h.dispose()).catch(() => {});
  }
}

/**
 * `-file-line-error` makes TeX say `./main.tex:12: Undefined control sequence.`
 * The first few, de-duplicated; a cascade after the first error is noise.
 */
export function parseErrors(log: string, mainFile: string): BuildError[] {
  const out: BuildError[] = [];
  // "Emergency stop" is TeX giving up, not the reason; the reason is the
  // LaTeX error that preceded it, e.g. a file that could not be found.
  const reason = log.match(/^! LaTeX Error: (.+)$/m)?.[1];
  for (const m of log.matchAll(/^(?:\.\/)?([^\s:]+\.(?:tex|sty|cls|bbl|bib)):(\d+): (.+)$/gm)) {
    let message = m[3]!.replace(/\.$/, '');
    if (/^Emergency stop/.test(message) && reason) message = reason.replace(/\.$/, '');
    if (!out.some((e) => e.line === Number(m[2]) && e.message === message)) {
      out.push({ file: m[1]!, line: Number(m[2]), message });
    }
    if (out.length >= 5) break;
  }
  if (out.length === 0) {
    const bang = log.match(/^! (.+)$/m);
    out.push({ file: mainFile, line: null, message: bang?.[1] ?? 'The document did not compile.' });
  }
  return out;
}

/** Must match the server's hash exactly — see docs/protocol.md. */
export async function hashSources(sources: Map<string, string>): Promise<string> {
  const pairs = [...sources].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bytes = new TextEncoder().encode(JSON.stringify(pairs));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
