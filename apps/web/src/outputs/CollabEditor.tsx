/**
 * The shared editor: CodeMirror bound to one Y.Text, with other people's named
 * cursors, a formatting toolbar, and optional error-line marks. Markdown and
 * LaTeX outputs differ only in the language and the toolbar they pass in.
 */
import { useEffect, useRef, useState } from 'react';
import { Decoration, EditorView, keymap, placeholder as cmPlaceholder, type KeyBinding } from '@codemirror/view';
import { EditorState, StateEffect, StateField, type Extension } from '@codemirror/state';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next';
import * as Y from 'yjs';
import type { Awareness } from 'y-protocols/awareness';

export interface ToolbarItem {
  label: string;
  title: string;
  run: (v: EditorView) => boolean;
  className?: string;
}

export const editorTheme = EditorView.theme(
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
    '.cm-error-line': { backgroundColor: '#f8717122', boxShadow: 'inset 3px 0 0 #f87171' },
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

/** Wrap the selection in markers, or remove them if it is already wrapped. */
export function wrap(view: EditorView, before: string, after: string, fallback: string) {
  const { from, to } = view.state.selection.main;
  const text = view.state.sliceDoc(from, to) || fallback;
  if (
    from !== to &&
    view.state.sliceDoc(from - before.length, from) === before &&
    view.state.sliceDoc(to, to + after.length) === after
  ) {
    view.dispatch({
      changes: [
        { from: from - before.length, to: from, insert: '' },
        { from: to, to: to + after.length, insert: '' },
      ],
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: `${before}${text}${after}` },
      selection: { anchor: from + before.length, head: from + before.length + text.length },
    });
  }
  view.focus();
  return true;
}

/** Insert a block on its own line, selecting the placeholder inside it. */
export function insertBlock(view: EditorView, text: string, select?: string) {
  const { from } = view.state.selection.main;
  const line = view.state.doc.lineAt(from);
  const atStart = from === line.from && line.length === 0;
  const insert = (atStart ? '' : '\n') + text + '\n';
  const pos = atStart ? from : line.to;
  const at = select ? insert.indexOf(select) : -1;
  view.dispatch({
    changes: { from: pos, insert },
    selection: at >= 0 ? { anchor: pos + at, head: pos + at + select!.length } : { anchor: pos + insert.length },
  });
  view.focus();
  return true;
}

const setErrors = StateEffect.define<number[]>();
const errorLines = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setErrors)) continue;
      const marks = e.value
        .filter((n) => n >= 1 && n <= tr.state.doc.lines)
        .map((n) => Decoration.line({ class: 'cm-error-line' }).range(tr.state.doc.line(n).from));
      deco = Decoration.set(marks, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Move the cursor to a line and bring it into view. */
export function goToLine(view: EditorView, line: number) {
  const n = Math.max(1, Math.min(line, view.state.doc.lines));
  const pos = view.state.doc.line(n).from;
  view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  view.focus();
}

export function CollabEditor({
  ytext,
  awareness,
  language,
  toolbar,
  keys = [],
  placeholder,
  markLines = [],
  onView,
  readOnly = false,
}: {
  ytext: Y.Text;
  awareness: Awareness;
  language: Extension;
  toolbar: ToolbarItem[];
  keys?: KeyBinding[];
  placeholder: string;
  /** Lines to mark as errors (1-based). */
  markLines?: number[];
  onView?: (view: EditorView | null) => void;
  /** A viewer (M22). Display only — the server drops their updates regardless. */
  readOnly?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!host.current) return;
    const undoManager = new Y.UndoManager(ytext);
    const v = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          keymap.of([...keys, ...yUndoManagerKeymap, indentWithTab, ...defaultKeymap]),
          language,
          EditorView.lineWrapping,
          editorTheme,
          errorLines,
          cmPlaceholder(placeholder),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          yCollab(ytext, awareness, { undoManager }),
        ],
      }),
      parent: host.current,
    });
    view.current = v;
    onView?.(v);
    setReady(true);
    return () => {
      onView?.(null);
      v.destroy();
      undoManager.destroy();
      view.current = null;
      setReady(false);
    };
    // The editor is rebuilt only for a different text: language and toolbar are
    // fixed per output kind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ytext, awareness]);

  useEffect(() => {
    view.current?.dispatch({ effects: setErrors.of(markLines) });
  }, [markLines, ready]);

  return (
    <div className="editor-wrap">
      {!readOnly && (
      <div className="toolbar" role="toolbar" aria-label="Formatting">
        {toolbar.map((t) => (
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
      )}
      <div ref={host} className="editor" />
    </div>
  );
}

/** Watch a Y.Map of files and return the Y.Text for one, once it exists. */
export function useYFile(doc: Y.Doc | null, file: string): Y.Text | null {
  const [text, setText] = useState<Y.Text | null>(null);
  useEffect(() => {
    if (!doc) return;
    const files = doc.getMap<Y.Text>('files');
    const update = () => setText(files.get(file) ?? null);
    update();
    files.observe(update);
    return () => files.unobserve(update);
  }, [doc, file]);
  return text;
}
