/**
 * The output in its own tab (M49, ADR 0045): a room's right pane alone, full
 * width and live, at /o/<owner>/s/<session>/output, with a tab strip of its
 * own: Documents (the overview) and one tab per open document. Which tabs are
 * open is remembered per room on this device, apart from the room's pane
 * state. `?doc=<id>` opens that document as a tab (the room's ↗ sends it).
 */
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Output, OutputEditSummary, SessionView } from '@fabrikka/types';
import { ApiError, openStream, sessions, type SessionRef } from '../api.ts';
import { useAuth } from '../auth-context.tsx';
import { OutputsPanel, type OutputTab } from '../outputs/Outputs.tsx';
import { ArtifactsPanel, ContextPanel, LinksPanel } from './SessionPage.tsx';

const OutputView = lazy(() => import('../outputs/OutputView.tsx'));

/** Open documents, in order, and the active one; null is the overview. */
interface Tabs {
  open: string[];
  active: string | null;
}

function useTabs(key: string, seed: string | null): [Tabs, (next: (prev: Tabs) => Tabs) => void] {
  const storageKey = `fabrikka.output-tabs.${key}`;
  const [tabs, setTabs] = useState<Tabs>(() => {
    let t: Tabs = { open: [], active: null };
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<Tabs>;
        t = {
          open: Array.isArray(parsed.open) ? parsed.open.filter((x): x is string => typeof x === 'string') : [],
          active: typeof parsed.active === 'string' ? parsed.active : null,
        };
      }
    } catch {
      // Remembered tabs are a convenience; without storage, start on the overview.
    }
    if (seed) t = { open: t.open.includes(seed) ? t.open : [...t.open, seed], active: seed };
    return t;
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(tabs));
    } catch {
      // Same: a window that works but forgets its tabs is fine.
    }
  }, [storageKey, tabs]);
  return [tabs, setTabs];
}

export function OutputPage() {
  const { owner = '', session = '' } = useParams();
  const ref = useMemo<SessionRef>(() => ({ owner, session }), [owner, session]);
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [seed] = useState(() => params.get('doc'));
  const [view, setView] = useState<SessionView | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [panelsVersion, setPanelsVersion] = useState(0);
  const [outputs, setOutputs] = useState<Output[] | null>(null);
  const [outputsVersion, setOutputsVersion] = useState(0);
  const [commentsVersion, setCommentsVersion] = useState(0);
  const [outputTab, setOutputTab] = useState<OutputTab>('edit');
  const [focusEdit, setFocusEdit] = useState<OutputEditSummary | null>(null);
  const [renameOnOpen, setRenameOnOpen] = useState(false);
  const [tabs, setTabs] = useTabs(`${owner}/${session}`, seed);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;

  // The seed is consumed: a reload shows the remembered tabs, not the sent one again.
  useEffect(() => {
    if (!params.has('doc')) return;
    setParams(
      (p) => {
        p.delete('doc');
        return p;
      },
      { replace: true },
    );
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    sessions
      .get(ref)
      .then(setView)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
      });
  }, [ref]);

  useEffect(() => {
    sessions
      .outputs(ref)
      .then((list) => {
        setOutputs(list);
        // A deleted document's tab closes itself.
        const ids = new Set(list.map((o) => o.id));
        const t = tabsRef.current;
        if (t.open.some((id) => !ids.has(id)) || (t.active && !ids.has(t.active))) {
          setTabs((prev) => {
            const open = prev.open.filter((id) => ids.has(id));
            return { open, active: prev.active && ids.has(prev.active) ? prev.active : null };
          });
        }
      })
      .catch(() => {});
  }, [ref, outputsVersion, setTabs]);

  // The same stream as the room; only what the right pane shows is tracked.
  useEffect(
    () =>
      openStream(
        ref,
        (event) => {
          if (event.type === 'context.updated' || event.type === 'artifact.created' || event.type === 'links.changed') {
            setPanelsVersion((v) => v + 1);
          }
          if (event.type === 'output.changed' || event.type === 'output.edited') setOutputsVersion((v) => v + 1);
          if (event.type === 'comments.changed') setCommentsVersion((v) => v + 1);
        },
        () => {},
      ),
    [ref],
  );

  useEffect(() => {
    if (view) document.title = `${view.session.title} — output · Fabrikka`;
  }, [view]);

  if (notFound) {
    return (
      <main className="centered">
        <div className="card">
          <h1>No such session</h1>
          <p className="muted">It doesn't exist, or you're not in it.</p>
          <Link to="/">← Home</Link>
        </div>
      </main>
    );
  }
  if (!view) return <main className="centered">Loading…</main>;

  const isOwner = view.me.role === 'owner';
  const isViewer = view.me.role === 'viewer';
  const list = outputs ?? [];
  const open = list.find((o) => o.id === tabs.active);
  const me =
    view.participants.find((p) => p.id === view.me.participantId) ??
    (isViewer && user
      ? { id: `viewer-${user.id}`, sessionId: view.session.id, kind: 'human' as const, displayName: user.displayName }
      : undefined);

  const openDocument = (id: string, opts: { tab?: OutputTab; edit?: OutputEditSummary; rename?: boolean } = {}) => {
    setOutputTab(opts.tab ?? 'edit');
    setFocusEdit(opts.edit ?? null);
    setRenameOnOpen(!!opts.rename);
    setTabs((prev) => ({ open: prev.open.includes(id) ? prev.open : [...prev.open, id], active: id }));
  };
  const activate = (id: string | null) => {
    setOutputTab('edit');
    setFocusEdit(null);
    setRenameOnOpen(false);
    setTabs((prev) => ({ ...prev, active: id }));
  };
  /** Closing a tab lands on its neighbour, or the overview when it was the last. */
  const closeTab = (id: string) =>
    setTabs((prev) => {
      const at = prev.open.indexOf(id);
      const open = prev.open.filter((x) => x !== id);
      const active = prev.active === id ? (open[Math.min(at, open.length - 1)] ?? null) : prev.active;
      return { open, active };
    });

  return (
    <div className="page output-only">
      <header className="output-only-head">
        <span className="muted small">Output of</span>
        <Link to={`/o/${owner}/s/${session}`} title="Open the room">
          {view.session.title}
        </Link>
      </header>
      <nav className="tabs output-tabs" role="tablist" aria-label="Open documents">
        <button role="tab" aria-selected={tabs.active === null} className={tabs.active === null ? 'tab on' : 'tab'} onClick={() => activate(null)}>
          Documents
        </button>
        {tabs.open.map((id) => {
          const o = list.find((x) => x.id === id);
          if (!o) return null;
          return (
            <span key={id} className={id === tabs.active ? 'tab-closable on' : 'tab-closable'}>
              <button role="tab" aria-selected={id === tabs.active} className={id === tabs.active ? 'tab on' : 'tab'} onClick={() => activate(id)}>
                {o.name}
              </button>
              <button className="tab-close" aria-label={`Close ${o.name}`} title="Close this tab" onClick={() => closeTab(id)}>
                ×
              </button>
            </span>
          );
        })}
      </nav>
      <div className="workspace output-only" data-output="open" data-doc={open ? 'open' : 'closed'}>
        <aside className="rail output" aria-label="Session output">
          {open && me ? (
            <Suspense fallback={<p className="muted small">Opening…</p>}>
              <OutputView
                key={open.id}
                ref_={ref}
                output={open}
                me={me}
                canDelete={!isViewer && (isOwner || open.createdBy.participantId === view.me.participantId)}
                readOnly={isViewer}
                tab={outputTab}
                onTab={(t) => {
                  setOutputTab(t);
                  if (t !== 'history') setFocusEdit(null);
                }}
                focusEdit={focusEdit}
                renameOnOpen={renameOnOpen}
                editsVersion={outputsVersion}
                commentsVersion={commentsVersion}
                onClose={() => closeTab(open.id)}
              />
            </Suspense>
          ) : (
            <>
              <OutputsPanel ref_={ref} outputs={list} onOpen={(id, o) => openDocument(id, o)} canCreate={!isViewer} />
              <LinksPanel ref_={ref} version={panelsVersion} readOnly={isViewer} />
              <fieldset className="plain" disabled={isViewer}>
                <ContextPanel key={`ctx-${panelsVersion}`} ref_={ref} />
              </fieldset>
              <ArtifactsPanel key={`art-${panelsVersion}`} ref_={ref} readOnly={isViewer} />
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
