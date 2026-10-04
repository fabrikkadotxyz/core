/**
 * The `doc` kind's body: a Markdown editor, a preview, and History.
 */
import { useEffect, useMemo, useState } from 'react';
import type { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import * as Y from 'yjs';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { OutputSync } from '../../sync.ts';
import { History } from '../../History.tsx';
import { CollabEditor, useYFile, wrap, type ToolbarItem } from '../../CollabEditor.tsx';
import type { KindBodyProps } from '../types.ts';

export default function DocBody({ ref_, output, sync, tab, focusEdit, editsVersion, readOnly }: KindBodyProps) {
  const file = output.mainFile;
  return (
    <>
      {tab === 'edit' && <Editor sync={sync} file={file} readOnly={readOnly} />}
      {tab === 'preview' && <Preview sync={sync} file={file} />}
      {tab === 'history' && (
        <History ref_={ref_} outputId={output.id} focusEditId={focusEdit?.id ?? null} version={editsVersion} />
      )}
    </>
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
  { tag: tags.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: tags.url, color: 'var(--muted)' },
  { tag: tags.monospace, fontFamily: 'ui-monospace, monospace', color: 'var(--danger)' },
  { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
  { tag: [tags.processingInstruction, tags.meta], color: 'var(--muted)' },
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

function Editor({ sync, file, readOnly }: { sync: OutputSync; file: string; readOnly: boolean }) {
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
      readOnly={readOnly}
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
