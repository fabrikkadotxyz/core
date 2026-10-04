/**
 * A LaTeX paper: source files, a live PDF, and where the build stands.
 * See ADR 0020 — the PDF is compiled here, in this browser, never on the server.
 *
 * The bar is someone who has written a paper in Word and never seen LaTeX: the
 * template compiles, the toolbar inserts the commands, the status line always
 * says whether the paper builds, and clicking an error takes you to its line.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { tags } from '@lezer/highlight';
import * as Y from 'yjs';
import type { Artifact, BuildError, Output, OutputEditSummary, TexConfig } from '@fabrikka/types';
import { sessions, type SessionRef } from '../../../api.ts';
import { CollabEditor, goToLine, insertBlock, useYFile, wrap, type ToolbarItem } from '../../CollabEditor.tsx';
import { History } from '../../History.tsx';
import type { OutputTab } from '../../Outputs.tsx';
import type { OutputSync } from '../../sync.ts';
import { LatexCompiler } from './compiler.ts';
import { PdfView } from './PdfView.tsx';
import { SyncTex, type SyncHit } from './synctex.ts';

/** Wait this long after the last keystroke before compiling. */
const COMPILE_DEBOUNCE_MS = 700;
const IMAGE = /\.(png|jpe?g|pdf|eps)$/i;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;

type BuildState =
  | { status: 'waiting' }
  | { status: 'building' }
  | { status: 'ok'; ms: number; at: number }
  | { status: 'failed'; errors: BuildError[] }
  | { status: 'unavailable' };

const latexLook = HighlightStyle.define([
  { tag: [tags.tagName, tags.keyword], color: '#7c9cff' },
  { tag: tags.comment, color: '#5d6375', fontStyle: 'italic' },
  { tag: [tags.atom, tags.number], color: '#f0abfc' },
  { tag: tags.bracket, color: '#a5b4c8' },
  { tag: tags.string, color: '#34d399' },
]);

const LATEX_LANGUAGE = [StreamLanguage.define(stex), syntaxHighlighting(latexLook)];

function latexToolbar(figureNames: () => string[], citeKeys: () => string[]): ToolbarItem[] {
  return [
    { label: 'B', title: 'Bold', run: (v) => wrap(v, '\\textbf{', '}', 'bold text'), className: 'b' },
    { label: 'I', title: 'Italic (emphasis)', run: (v) => wrap(v, '\\emph{', '}', 'emphasis'), className: 'i' },
    { label: '§', title: 'Section', run: (v) => insertBlock(v, '\\section{Section title}', 'Section title') },
    { label: '§§', title: 'Subsection', run: (v) => insertBlock(v, '\\subsection{Subsection title}', 'Subsection title') },
    {
      label: '•',
      title: 'Bulleted list',
      run: (v) => insertBlock(v, '\\begin{itemize}\n  \\item First point\n  \\item Second point\n\\end{itemize}', 'First point'),
    },
    {
      label: '∑',
      title: 'Equation',
      run: (v) => insertBlock(v, '\\begin{equation}\n  E = mc^2\n\\end{equation}', 'E = mc^2'),
    },
    {
      label: '[1]',
      title: 'Cite a reference from refs.bib',
      run: (v) => {
        const keys = citeKeys();
        const key = window.prompt(
          keys.length ? `Cite which reference?\n\n${keys.join('\n')}` : 'Citation key (from refs.bib)',
          keys[0] ?? '',
        );
        return key ? wrap(v, `~\\cite{${key.trim()}`, '}', '') : true;
      },
    },
    {
      label: '🖼',
      title: 'Figure — upload the image as a session file first',
      run: (v) => {
        const names = figureNames();
        const name = window.prompt(
          names.length ? `Which image?\n\n${names.join('\n')}` : 'Image file name (upload it under Files first)',
          names[0] ?? 'figure.png',
        );
        if (!name) return true;
        return insertBlock(
          v,
          `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.8\\linewidth]{${name.trim()}}\n  \\caption{Caption}\n\\end{figure}`,
          'Caption',
        );
      },
    },
  ];
}

export default function LatexBody({
  ref_,
  output,
  sync,
  tab,
  onTab,
  focusEdit,
  editsVersion,
  readOnly,
}: {
  ref_: SessionRef;
  output: Output;
  sync: OutputSync;
  tab: OutputTab;
  onTab: (t: OutputTab) => void;
  focusEdit: OutputEditSummary | null;
  editsVersion: number;
  readOnly: boolean;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [active, setActive] = useState(output.mainFile);
  const [build, setBuild] = useState<BuildState>({ status: 'waiting' });
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const [syncTex, setSyncTex] = useState<SyncTex | null>(null);
  const [figures, setFigures] = useState<string[]>([]);
  const editor = useRef<EditorView | null>(null);
  const pendingLine = useRef<number | null>(null);
  const compiler = useRef<LatexCompiler | null>(null);
  const assets = useRef(new Map<string, Uint8Array>());

  /* ---- files ---- */

  useEffect(() => {
    const map = sync.doc.getMap<Y.Text>('files');
    const update = () => {
      const names = [...map.keys()].sort((a, b) =>
        a === output.mainFile ? -1 : b === output.mainFile ? 1 : a.localeCompare(b),
      );
      setFiles(names);
      // Someone removed the file you were on.
      setActive((cur) => (names.includes(cur) || names.length === 0 ? cur : output.mainFile));
    };
    update();
    map.observe(update);
    return () => map.unobserve(update);
  }, [sync, output.mainFile]);

  const ytext = useYFile(sync.doc, active);

  /* ---- artifacts mounted as images ---- */

  const loadAssets = useCallback(async () => {
    const list = await sessions.artifacts(ref_).catch(() => [] as Artifact[]);
    const names: string[] = [];
    let total = 0;
    // Newest first: if two uploads share a name, the latest one is the figure.
    for (const a of list) {
      if (a.type !== 'file' || !IMAGE.test(a.name) || names.includes(a.name)) continue;
      if ((a.sizeBytes ?? 0) > MAX_ASSET_BYTES || total > 4 * MAX_ASSET_BYTES) continue;
      names.push(a.name);
      total += a.sizeBytes ?? 0;
      if (!assets.current.has(`${a.id}`)) {
        const res = await fetch(sessions.artifactUrl(ref_, a.id), { credentials: 'same-origin' });
        if (res.ok) assets.current.set(`${a.id}`, new Uint8Array(await res.arrayBuffer()));
      }
    }
    setFigures(names);
    // Keyed by id for caching, mounted by name for \includegraphics.
    const byName = new Map<string, Uint8Array>();
    for (const a of list) {
      const bytes = assets.current.get(a.id);
      if (bytes && names.includes(a.name) && !byName.has(a.name)) byName.set(a.name, bytes);
    }
    return byName;
  }, [ref_]);

  /* ---- the compile loop ---- */

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let again = false;

    const compile = async () => {
      if (running) {
        again = true;
        return;
      }
      const c = compiler.current;
      if (!c || stopped) return;
      running = true;
      setBuild({ status: 'building' });
      const map = sync.doc.getMap<Y.Text>('files');
      const sources = new Map([...map.entries()].map(([path, t]) => [path, t.toString()] as const));
      const images = await loadAssets();
      const result = await c.compile(sources, images, output.mainFile);
      running = false;
      if (stopped) return;

      if (result.ok && result.pdf) {
        setPdf(result.pdf);
        setBuild({ status: 'ok', ms: result.ms, at: Date.now() });
        setSyncTex(result.synctex ? await SyncTex.parse(result.synctex).catch(() => null) : null);
      } else {
        setBuild({ status: 'failed', errors: result.errors });
      }
      // Tell the server what this compile found, for agents (ADR 0020). It keeps
      // the report only if the hash still matches what is in the document.
      sync.sendControl({
        type: 'build.report',
        sourceHash: result.sourceHash,
        status: result.ok ? 'ok' : 'failed',
        errors: result.errors,
      });
      if (again) {
        again = false;
        schedule(0);
      }
    };

    const schedule = (ms = COMPILE_DEBOUNCE_MS) => {
      clearTimeout(timer);
      timer = setTimeout(() => void compile(), ms);
    };

    void sessions.kindGet<TexConfig | null>(ref_, '/tex').then((tex) => {
      if (stopped) return;
      if (!tex) {
        setBuild({ status: 'unavailable' });
        return;
      }
      compiler.current = new LatexCompiler(tex.assetsPath);
      compiler.current.warm();
      schedule(0);
    });

    const onUpdate = () => schedule();
    sync.doc.on('update', onUpdate);
    return () => {
      stopped = true;
      clearTimeout(timer);
      sync.doc.off('update', onUpdate);
      void compiler.current?.dispose();
      compiler.current = null;
    };
  }, [sync, ref_, output.mainFile, loadAssets]);

  /* ---- "show me": where an edit landed in the PDF ---- */

  const highlight = useMemo<(SyncHit & { key: string }) | null>(() => {
    if (!focusEdit?.lines || !syncTex) return null;
    // A deleted line has no output of its own; look a line either side.
    let hit = syncTex.forward(focusEdit.file, focusEdit.lines.start, focusEdit.lines.end);
    hit ??= syncTex.forward(focusEdit.file, Math.max(1, focusEdit.lines.start - 1), focusEdit.lines.end + 1);
    return hit ? { ...hit, key: focusEdit.id } : null;
  }, [focusEdit, syncTex]);

  /* ---- errors → lines ---- */

  const errorLines = useMemo(
    () =>
      build.status === 'failed'
        ? build.errors.filter((e) => e.file === active && e.line).map((e) => e.line!)
        : [],
    [build, active],
  );

  const jumpTo = (e: BuildError) => {
    if (files.includes(e.file) && e.file !== active) setActive(e.file);
    pendingLine.current = e.line;
    onTab('edit');
    if (editor.current && e.line && (e.file === active || !files.includes(e.file))) goToLine(editor.current, e.line);
  };

  const onView = useCallback((v: EditorView | null) => {
    editor.current = v;
    if (v && pendingLine.current) {
      goToLine(v, pendingLine.current);
      pendingLine.current = null;
    }
  }, []);

  // One object URL per PDF, released when the next one replaces it.
  const pdfUrl = useMemo(
    () => (pdf ? URL.createObjectURL(new Blob([pdf as Uint8Array<ArrayBuffer>], { type: 'application/pdf' })) : null),
    [pdf],
  );
  useEffect(() => () => void (pdfUrl && URL.revokeObjectURL(pdfUrl)), [pdfUrl]);

  const toolbar = useMemo(
    () =>
      latexToolbar(
        () => figures,
        () => {
          const bib = sync.doc.getMap<Y.Text>('files');
          const keys: string[] = [];
          for (const [path, t] of bib) {
            if (path.endsWith('.bib')) for (const m of t.toString().matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)) keys.push(m[1]!);
          }
          return keys;
        },
      ),
    [figures, sync],
  );

  return (
    <div className="latex-body">
      <BuildLine build={build} onJump={jumpTo} />

      {tab === 'edit' && (
        <>
          <div className="file-strip" role="tablist" aria-label="Files">
            {files.map((f) => (
              <span key={f} className={f === active ? 'file-tab on' : 'file-tab'}>
                <button role="tab" aria-selected={f === active} onClick={() => setActive(f)}>
                  {f}
                </button>
                {f !== output.mainFile && !readOnly && (
                  <button
                    className="file-remove"
                    title={`Remove ${f}`}
                    aria-label={`Remove ${f}`}
                    onClick={async () => {
                      if (!window.confirm(`Remove ${f} for everyone?`)) return;
                      await sessions.removeOutputFile(ref_, output.id, f).catch((err) => window.alert(err.message));
                    }}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
            {!readOnly && (
            <button
              className="file-add"
              title="Add a file — a section, or a .bib for references"
              onClick={async () => {
                const name = window.prompt('New file name, e.g. method.tex or more.bib');
                if (!name?.trim()) return;
                try {
                  await sessions.addOutputFile(ref_, output.id, name.trim());
                  setActive(name.trim());
                } catch (err) {
                  window.alert((err as Error).message);
                }
              }}
            >
              + File
            </button>
            )}
          </div>
          {ytext ? (
            <CollabEditor
              key={active}
              ytext={ytext}
              awareness={sync.awareness}
              language={LATEX_LANGUAGE}
              toolbar={toolbar}
              placeholder={active.endsWith('.bib') ? '@article{key, author = {…}, title = {…}, year = {…}}' : '\\section{…}'}
              markLines={errorLines}
              onView={onView}
              readOnly={readOnly}
            />
          ) : (
            <p className="muted small editor-loading">Opening…</p>
          )}
        </>
      )}

      {tab === 'preview' && (
        <>
          {pdfUrl && (
            <div className="pdf-actions">
              <a className="link small" download={`${output.name}.pdf`} href={pdfUrl}>
                Download PDF
              </a>
            </div>
          )}
          <PdfView pdf={pdf} highlight={highlight} />
        </>
      )}

      {tab === 'history' && (
        <History ref_={ref_} outputId={output.id} focusEditId={focusEdit?.id ?? null} version={editsVersion} />
      )}
    </div>
  );
}

/** One line that always says whether the paper builds. */
function BuildLine({ build, onJump }: { build: BuildState; onJump: (e: BuildError) => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);

  if (build.status === 'unavailable') {
    return <div className="build-line failed">LaTeX is not installed on this server. Ask whoever runs it to run <code>pnpm tex:install</code>.</div>;
  }
  if (build.status === 'waiting') return <div className="build-line">Loading the LaTeX compiler…</div>;
  if (build.status === 'building') return <div className="build-line building">Building…</div>;
  if (build.status === 'ok') {
    return (
      <div className="build-line ok">
        ✓ Up to date <span className="muted small">· built in {(build.ms / 1000).toFixed(1)} s</span>
      </div>
    );
  }
  const [first, ...rest] = build.errors;
  return (
    <div className="build-line failed">
      <button className="link" onClick={() => first && onJump(first)} title="Go to the line">
        ✗ {first?.line ? `${first.file} line ${first.line}: ` : ''}
        {first?.message}
      </button>
      {rest.length > 0 && <span className="muted small"> · {rest.length} more</span>}
    </div>
  );
}
