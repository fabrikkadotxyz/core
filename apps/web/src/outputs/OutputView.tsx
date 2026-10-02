/**
 * One open output: editor, preview and history. Loaded lazily — see Outputs.tsx.
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import * as Y from 'yjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Output, OutputEditSummary, Participant } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';
import type { OutputTab } from './Outputs.tsx';
import { colorFor, connectOutput, type OutputSync, type SyncStatus } from './sync.ts';
import { History } from './History.tsx';
import { CollabEditor, useYFile, wrap, type ToolbarItem } from './CollabEditor.tsx';

/** The TeX engine and PDF renderer are large; only papers pay for them. */
const LatexBody = lazy(() => import('./latex/LatexBody.tsx'));

/* -------------------------------------------------------------------------- */
/* One open output                                                            */
/* -------------------------------------------------------------------------- */

export default function OutputView({
  ref_,
  output,
  me,
  canDelete,
  tab,
  onTab,
  focusEdit,
  renameOnOpen,
  editsVersion,
  onClose,
}: {
  ref_: SessionRef;
  output: Output;
  me: Participant;
  canDelete: boolean;
  tab: OutputTab;
  onTab: (t: OutputTab) => void;
  /** An edit to show — from "Show me" in the timeline or the notice. */
  focusEdit: OutputEditSummary | null;
  renameOnOpen: boolean;
  /** Bumped whenever an edit to this output is published. */
  editsVersion: number;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<SyncStatus>('connecting');
  const [sync, setSync] = useState<OutputSync | null>(null);
  const [people, setPeople] = useState<{ name: string; color: string }[]>([]);

  useEffect(() => {
    const s = connectOutput(ref_, output.id, { name: me.displayName, color: colorFor(me.id) }, setStatus);
    const onAwareness = () => {
      const seen = new Map<string, { name: string; color: string }>();
      for (const [id, st] of s.awareness.getStates()) {
        const u = (st as { user?: { name: string; color: string } }).user;
        if (u && id !== s.doc.clientID) seen.set(u.name, u);
      }
      setPeople([...seen.values()]);
    };
    s.awareness.on('change', onAwareness);
    setSync(s);
    return () => {
      s.awareness.off('change', onAwareness);
      s.destroy();
      setSync(null);
    };
  }, [ref_, output.id, me.displayName, me.id]);

  const file = output.mainFile;
  const isLatex = output.kind === 'latex';

  return (
    <section className="output-view" aria-label={`Document: ${output.name}`}>
      <header className="output-head">
        <button className="link back" onClick={onClose} title="Back to all documents">
          ← Documents
        </button>
        <span className="spacer" />
        <Presence people={people} />
        {canDelete && (
          <button
            className="link danger small"
            onClick={async () => {
              if (!window.confirm(`Delete "${output.name}" for everyone in this session?`)) return;
              await sessions.deleteOutput(ref_, output.id);
              onClose();
            }}
          >
            Delete
          </button>
        )}
      </header>

      <TitleField ref_={ref_} output={output} autoFocus={renameOnOpen} />

      <div className="tabs" role="tablist">
        {(
          [
            ['edit', isLatex ? 'Source' : 'Edit'],
            ['preview', isLatex ? 'PDF' : 'Preview'],
            ['history', 'History'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={tab === key ? 'tab on' : 'tab'}
            onClick={() => onTab(key)}
          >
            {label}
          </button>
        ))}
        <span className="spacer" />
        <SyncBadge status={status} />
      </div>

      {isLatex ? (
        sync && (
          <Suspense fallback={<p className="muted small">Loading the LaTeX tools…</p>}>
            <LatexBody
              ref_={ref_}
              output={output}
              sync={sync}
              tab={tab}
              onTab={onTab}
              focusEdit={focusEdit}
              editsVersion={editsVersion}
            />
          </Suspense>
        )
      ) : (
        <>
          {sync && tab === 'edit' && <Editor sync={sync} file={file} />}
          {sync && tab === 'preview' && <Preview sync={sync} file={file} />}
          {tab === 'history' && (
            <History ref_={ref_} outputId={output.id} focusEditId={focusEdit?.id ?? null} version={editsVersion} />
          )}
        </>
      )}
    </section>
  );
}

function TitleField({ ref_, output, autoFocus }: { ref_: SessionRef; output: Output; autoFocus: boolean }) {
  const [name, setName] = useState(output.name);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => setName(output.name), [output.name]);
  useEffect(() => {
    if (autoFocus) input.current?.select();
  }, [autoFocus]);

  const save = () => {
    const next = name.trim();
    if (!next) return setName(output.name);
    if (next !== output.name) void sessions.renameOutput(ref_, output.id, next);
  };

  return (
    <input
      ref={input}
      className="output-title"
      value={name}
      aria-label="Document name"
      onChange={(e) => setName(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setName(output.name);
          setTimeout(() => input.current?.blur());
        }
      }}
    />
  );
}

function Presence({ people }: { people: { name: string; color: string }[] }) {
  if (people.length === 0) return <span className="muted small">Only you here</span>;
  return (
    <span className="presence" title={`Also here: ${people.map((p) => p.name).join(', ')}`}>
      {people.slice(0, 5).map((p) => (
        <span key={p.name} className="avatar" style={{ background: p.color }}>
          {p.name.slice(0, 1).toUpperCase()}
        </span>
      ))}
      {people.length > 5 && <span className="muted small">+{people.length - 5}</span>}
    </span>
  );
}

function SyncBadge({ status }: { status: SyncStatus }) {
  const label = {
    connecting: 'Connecting…',
    synced: 'Live',
    offline: 'Reconnecting…',
    refused: 'Unavailable',
  }[status];
  return (
    <span className={`sync-badge ${status}`} title="Changes are saved and shared as you type">
      {label}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* The editor                                                                 */
/* -------------------------------------------------------------------------- */

const markdownLook = HighlightStyle.define([
  { tag: tags.heading1, fontSize: '1.5em', fontWeight: '700' },
  { tag: tags.heading2, fontSize: '1.25em', fontWeight: '700' },
  { tag: tags.heading3, fontSize: '1.1em', fontWeight: '700' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.link, color: '#7c9cff', textDecoration: 'underline' },
  { tag: tags.url, color: '#8b91a3' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, monospace', color: '#f0abfc' },
  { tag: tags.quote, color: '#a5b4c8', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.meta], color: '#5d6375' },
]);

/** Toggle a prefix on every selected line: headings, lists, quotes. */
function linePrefix(view: EditorView, prefix: string | ((i: number) => string)) {
  const { from, to } = view.state.selection.main;
  const first = view.state.doc.lineAt(from).number;
  const last = view.state.doc.lineAt(to).number;
  const changes = [];
  const strip = /^(#{1,6} |[-*] |\d+\. |> )/;
  for (let n = first, i = 1; n <= last; n++, i++) {
    const line = view.state.doc.line(n);
    const want = typeof prefix === 'function' ? prefix(i) : prefix;
    const has = line.text.match(strip)?.[0];
    if (has === want) changes.push({ from: line.from, to: line.from + has.length, insert: '' });
    else changes.push({ from: line.from, to: line.from + (has?.length ?? 0), insert: want });
  }
  // Map the cursor to AFTER an inserted prefix, or the next thing typed lands
  // in front of the "## " instead of after it.
  const set = view.state.changes(changes);
  view.dispatch({ changes: set, selection: view.state.selection.map(set, 1) });
  view.focus();
  return true;
}

function insertLink(view: EditorView) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to) || 'link text';
  const url = window.prompt('Link address', 'https://');
  if (!url) return true;
  view.dispatch({ changes: { from, to, insert: `[${text}](${url})` } });
  view.focus();
  return true;
}

const MARKDOWN_TOOLBAR: ToolbarItem[] = [
  { label: 'B', title: 'Bold (⌘B)', run: (v) => wrap(v, '**', '**', 'bold text'), className: 'b' },
  { label: 'I', title: 'Italic (⌘I)', run: (v) => wrap(v, '_', '_', 'italic text'), className: 'i' },
  { label: 'H1', title: 'Big heading', run: (v) => linePrefix(v, '# ') },
  { label: 'H2', title: 'Heading', run: (v) => linePrefix(v, '## ') },
  { label: '•', title: 'Bulleted list', run: (v) => linePrefix(v, '- ') },
  { label: '1.', title: 'Numbered list', run: (v) => linePrefix(v, (i) => `${i}. `) },
  { label: '❝', title: 'Quote', run: (v) => linePrefix(v, '> ') },
  { label: '🔗', title: 'Link (⌘K)', run: insertLink },
  { label: '</>', title: 'Code', run: (v) => wrap(v, '`', '`', 'code') },
];

const MARKDOWN_KEYS = [
  { key: 'Mod-b', run: (v: EditorView) => wrap(v, '**', '**', 'bold text') },
  { key: 'Mod-i', run: (v: EditorView) => wrap(v, '_', '_', 'italic text') },
  { key: 'Mod-k', run: insertLink },
];

const MARKDOWN_LANGUAGE = [markdown(), syntaxHighlighting(markdownLook)];

function Editor({ sync, file }: { sync: OutputSync; file: string }) {
  const ytext = useYFile(sync.doc, file);
  if (!ytext) return <p className="muted small editor-loading">Opening…</p>;
  return (
    <CollabEditor
      ytext={ytext}
      awareness={sync.awareness}
      language={MARKDOWN_LANGUAGE}
      toolbar={MARKDOWN_TOOLBAR}
      keys={MARKDOWN_KEYS}
      placeholder="Start writing… Use the buttons above for headings and lists."
    />
  );
}

function Preview({ sync, file }: { sync: OutputSync; file: string }) {
  const [source, setSource] = useState('');

  useEffect(() => {
    const files = sync.doc.getMap<Y.Text>('files');
    let text: Y.Text | undefined;
    const update = () => setSource(text?.toString() ?? '');
    const attach = () => {
      const next = files.get(file);
      if (next === text) return;
      text?.unobserve(update);
      text = next;
      text?.observe(update);
      update();
    };
    attach();
    files.observe(attach);
    return () => {
      files.unobserve(attach);
      text?.unobserve(update);
    };
  }, [sync, file]);

  // Written by every participant and their agents: sanitised, always.
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(source, { async: false }) as string),
    [source],
  );

  return source.trim() ? (
    <article className="preview" dangerouslySetInnerHTML={{ __html: html }} />
  ) : (
    <p className="muted preview-empty">Nothing written yet.</p>
  );
}
