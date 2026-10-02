/**
 * One open output: editor, preview and history. Loaded lazily — see Outputs.tsx.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { Output, OutputEdit, Participant } from '@fabrikka/types';
import { sessions, type SessionRef } from '../api.ts';
import { timeAgo, type OutputTab } from './Outputs.tsx';
import { colorFor, connectOutput, type OutputSync, type SyncStatus } from './sync.ts';

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
  focusEditId,
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
  /** An edit to expand in History — from "show me" in the timeline. */
  focusEditId: string | null;
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
            ['edit', 'Edit'],
            ['preview', 'Preview'],
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

      {sync && tab === 'edit' && <Editor sync={sync} file={file} />}
      {sync && tab === 'preview' && <Preview sync={sync} file={file} />}
      {tab === 'history' && (
        <History ref_={ref_} outputId={output.id} focusEditId={focusEditId} version={editsVersion} />
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

const editorTheme = EditorView.theme(
  {
    '&': { color: 'var(--text)', backgroundColor: 'transparent', fontSize: '15px' },
    '.cm-content': {
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
      lineHeight: '1.65',
      padding: '0.75rem 0 3rem',
      caretColor: 'var(--accent)',
    },
    '.cm-line': { padding: '0 0.25rem' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: '#7c9cff44',
    },
    '.cm-placeholder': { color: 'var(--muted)' },
    '.cm-ySelectionInfo': {
      fontFamily: 'ui-sans-serif, system-ui, sans-serif',
      fontSize: '11px',
      padding: '1px 4px',
      borderRadius: '4px',
      opacity: '1',
      top: '-1.4em',
    },
  },
  { dark: true },
);

/** Wrap the selection in a marker, or remove it if it is already wrapped. */
function wrap(view: EditorView, mark: string, fallback: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to) || fallback;
  const before = view.state.sliceDoc(from - mark.length, from);
  const after = view.state.sliceDoc(to, to + mark.length);
  if (from !== to && before === mark && after === mark) {
    view.dispatch({
      changes: [
        { from: from - mark.length, to: from, insert: '' },
        { from: to, to: to + mark.length, insert: '' },
      ],
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: `${mark}${text}${mark}` },
      selection: { anchor: from + mark.length, head: from + mark.length + text.length },
    });
  }
  view.focus();
  return true;
}

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

const TOOLBAR: { label: string; title: string; run: (v: EditorView) => boolean; className?: string }[] = [
  { label: 'B', title: 'Bold (⌘B)', run: (v) => wrap(v, '**', 'bold text'), className: 'b' },
  { label: 'I', title: 'Italic (⌘I)', run: (v) => wrap(v, '_', 'italic text'), className: 'i' },
  { label: 'H1', title: 'Big heading', run: (v) => linePrefix(v, '# ') },
  { label: 'H2', title: 'Heading', run: (v) => linePrefix(v, '## ') },
  { label: '•', title: 'Bulleted list', run: (v) => linePrefix(v, '- ') },
  { label: '1.', title: 'Numbered list', run: (v) => linePrefix(v, (i) => `${i}. `) },
  { label: '❝', title: 'Quote', run: (v) => linePrefix(v, '> ') },
  { label: '🔗', title: 'Link (⌘K)', run: insertLink },
  { label: '</>', title: 'Code', run: (v) => wrap(v, '`', 'code') },
];

function Editor({ sync, file }: { sync: OutputSync; file: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const files = sync.doc.getMap<Y.Text>('files');
    let destroyed = false;

    // The file arrives with the first sync; mount the editor once it exists.
    const mount = () => {
      const ytext = files.get(file);
      if (!ytext || view.current || destroyed || !host.current) return;
      const undoManager = new Y.UndoManager(ytext);
      const extensions: Extension[] = [
        keymap.of([
          { key: 'Mod-b', run: (v) => wrap(v, '**', 'bold text') },
          { key: 'Mod-i', run: (v) => wrap(v, '_', 'italic text') },
          { key: 'Mod-k', run: insertLink },
          ...yUndoManagerKeymap,
          indentWithTab,
          ...defaultKeymap,
        ]),
        markdown(),
        syntaxHighlighting(markdownLook),
        EditorView.lineWrapping,
        editorTheme,
        cmPlaceholder('Start writing… Use the buttons above for headings and lists.'),
        yCollab(ytext, sync.awareness, { undoManager }),
      ];
      view.current = new EditorView({
        state: EditorState.create({ doc: ytext.toString(), extensions }),
        parent: host.current,
      });
      setReady(true);
    };

    mount();
    files.observe(mount);
    return () => {
      destroyed = true;
      files.unobserve(mount);
      view.current?.destroy();
      view.current = null;
    };
  }, [sync, file]);

  return (
    <div className="editor-wrap">
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        {TOOLBAR.map((t) => (
          <button
            key={t.label}
            className={t.className}
            title={t.title}
            aria-label={t.title}
            disabled={!ready}
            // Keep the editor's selection: a toolbar click must not blur it first.
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => view.current && t.run(view.current)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {!ready && <p className="muted small editor-loading">Opening…</p>}
      <div ref={host} className="editor" />
    </div>
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

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

function History({
  ref_,
  outputId,
  focusEditId,
  version,
}: {
  ref_: SessionRef;
  outputId: string;
  focusEditId: string | null;
  version: number;
}) {
  const [edits, setEdits] = useState<OutputEdit[] | null>(null);
  const [open, setOpen] = useState<string | null>(focusEditId);

  useEffect(() => {
    sessions.outputChanges(ref_, outputId).then(setEdits).catch(() => setEdits([]));
  }, [ref_, outputId, version]);

  useEffect(() => {
    if (focusEditId) setOpen(focusEditId);
  }, [focusEditId]);

  if (!edits) return <p className="muted small">Loading…</p>;
  if (edits.length === 0) {
    return (
      <p className="muted history-empty">
        No changes yet. Edits by people and agents show up here, each with exactly
        what changed. Typing is grouped after a few seconds' pause.
      </p>
    );
  }

  return (
    <ol className="history">
      {edits.map((e) => (
        <li key={e.id} className={open === e.id ? 'open' : ''}>
          <button className="history-row" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <span className="avatar" style={{ background: colorFor(e.participantId ?? e.displayName) }}>
              {e.displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="history-who">
              @{e.displayName}
              {e.participantKind === 'agent' && <span className="badge">agent</span>}
            </span>
            <span className="history-delta">
              <span className="plus">+{e.added}</span> <span className="minus">−{e.removed}</span>
            </span>
            <time className="muted small" dateTime={e.at} title={new Date(e.at).toLocaleString()}>
              {timeAgo(e.at)}
            </time>
          </button>
          {open === e.id && <Diff diff={e.diff} />}
        </li>
      ))}
    </ol>
  );
}

function Diff({ diff }: { diff: string }) {
  return (
    <pre className="diff">
      {diff.split('\n').map((line, i) => (
        <span
          key={i}
          className={
            line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : ''
          }
        >
          {line.startsWith('@@') ? '⋯' : line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
