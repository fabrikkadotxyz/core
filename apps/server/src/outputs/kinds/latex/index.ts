/**
 * `latex`: a paper with a live PDF beside it. See ADR 0020 — the server never
 * runs TeX; viewers' browsers compile, and report what they found.
 */
import { createHash } from 'node:crypto';
import type { BuildError, BuildReport } from '@fabrikka/types';
import type { KindContext, OutputKindModule } from '../../contract.ts';
import { yjsStore } from '../../yjs-store.ts';
import { serveTexAsset, texAssetsPath, texAvailable } from './tex-assets.ts';

/** Text files a paper may hold. Images come from artifacts. */
const FILE_PATH =
  /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]*\/){0,3}[A-Za-z0-9_-][A-Za-z0-9._-]*\.(?:tex|bib|sty|cls|bst|txt)$/;

function acceptsFile(path: string): boolean {
  return FILE_PATH.test(path) && !path.includes('..') && path.length <= 120;
}

/** A document name as a LaTeX title: drop the characters TeX would choke on. */
function texSafe(name: string): string {
  return name.replace(/[\\{}$&#^_%~]/g, '');
}

type StoredBuild = Omit<BuildReport, 'viewers'>;

/** What a browser hashes to say what it compiled. See docs/protocol.md. */
function sourceHash(ctx: KindContext): string {
  const pairs = [...ctx.files().entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(pairs)).digest('hex');
}

export const latex: OutputKindModule = {
  id: 'latex',
  name: 'LaTeX paper',
  description: 'A paper with a live PDF beside it. Compiled in your browser; citations included.',
  icon: '∑',
  defaultName: 'Untitled paper',
  format: 'latex',
  multiFile: true,
  mainFile: 'main.tex',
  files: {
    accepts: acceptsFile,
    rule: 'a relative path ending in .tex, .bib, .sty, .cls, .bst or .txt',
    example: 'section.tex or refs.bib',
  },
  // Absent, not broken, on an instance without the TeX assets (ADR 0020).
  available: texAvailable,
  store: yjsStore,
  agentHint: 'For latex, read_output afterwards: its `build` says whether your edit compiled.',

  // A working paper, so the first thing anyone sees is a PDF, not an error.
  template: (name) => ({
    'main.tex': [
      '\\documentclass{article}',
      '\\usepackage{amsmath}',
      '\\usepackage{graphicx}',
      '\\usepackage{hyperref}',
      '',
      `\\title{${texSafe(name)}}`,
      '\\author{}',
      '\\date{\\today}',
      '',
      '\\begin{document}',
      '\\maketitle',
      '',
      '\\section{Introduction}',
      'Start writing here. Cite sources from \\texttt{refs.bib} like this~\\cite{knuth1984}.',
      '',
      '\\bibliographystyle{plain}',
      '\\bibliography{refs}',
      '',
      '\\end{document}',
      '',
    ].join('\n'),
    'refs.bib': [
      '@article{knuth1984,',
      '  author  = {Donald E. Knuth},',
      '  title   = {Literate Programming},',
      '  journal = {The Computer Journal},',
      '  volume  = {27},',
      '  number  = {2},',
      '  pages   = {97--111},',
      '  year    = {1984}',
      '}',
      '',
    ].join('\n'),
  }),

  // A paper whose \title is still the old name follows the rename, so the PDF
  // does not keep saying "Untitled paper". Only an exact match: a title someone
  // has written themselves is theirs, not the document name's.
  async onRenamed(ctx, { before, after, participantId }) {
    await ctx.edit(participantId, {
      kind: 'edits',
      edits: [{ old_text: `\\title{${texSafe(before)}}`, new_text: `\\title{${texSafe(after)}}` }],
    });
  },

  /**
   * A report counts only for the version it was made against. Anything else is
   * "unknown" — never "passed" (ADR 0020).
   */
  readExtras(ctx) {
    const viewers = ctx.viewers;
    const build = ctx.kindData.build as StoredBuild | undefined;
    const report: BuildReport =
      build && build.version === ctx.version
        ? { ...build, viewers }
        : { status: 'unknown', version: null, at: null, errors: [], viewers };
    return { build: report };
  },

  async onClientMessage(ctx, msg) {
    if (msg.type !== 'build.report') return;
    // Stale — someone typed since this browser compiled. Dropped, not mislabelled.
    if (typeof msg.sourceHash !== 'string' || msg.sourceHash !== sourceHash(ctx)) return;
    if (msg.status !== 'ok' && msg.status !== 'failed') return;
    const errors: BuildError[] = (Array.isArray(msg.errors) ? msg.errors : [])
      .slice(0, 20)
      .map((e: Record<string, unknown>) => ({
        file: String(e?.file ?? '').slice(0, 120),
        line: typeof e?.line === 'number' && Number.isFinite(e.line) ? Math.trunc(e.line) : null,
        message: String(e?.message ?? '').slice(0, 300),
      }));
    const build: StoredBuild = { status: msg.status, version: ctx.version, at: new Date().toISOString(), errors };
    await ctx.setKindData({ build });
  },

  routes: {
    /**
     * TeX engine and TeX Live tree for viewers' browsers (ADR 0020). Public on
     * purpose: they are stock TeX Live files, the same for everyone, and a browser
     * fetching them for a compile carries no session. The server never runs them.
     */
    public(app) {
      app.get('/tex-assets/*', (c) => serveTexAsset(c.req.path.slice('/tex-assets/'.length)));
    },
    /** Where browsers load the TeX engine from — null when LaTeX is not installed. */
    session(routes, member) {
      routes.get('/tex', async (c) => {
        if (!(await member(c))) return c.notFound();
        const assetsPath = texAssetsPath();
        return c.json(assetsPath ? { assetsPath } : null);
      });
    },
  },
};
