/**
 * Personal integrations (M28, M18): your own connections, outside any session.
 *
 * A connection is yours — your account, your token, sealed at rest and never
 * shown again (ADRs 0004, 0014). Listed vendors connect with one click and their
 * own sign-in (OAuth, ADR 0024); anything else is a custom connection, a URL and
 * a token. Attaching one to a session, and granting its tools there, stays in
 * that session's Setup.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { connections, type CatalogueItem, type VendorLogo } from '../api.ts';
import { Select } from '../components/Select.tsx';
import { inDesktopApp } from '../desktop.ts';

type Conn = Awaited<ReturnType<typeof connections.list>>['connections'][number];

export function IntegrationsPage() {
  const [list, setList] = useState<Conn[] | null>(null);
  const [catalogue, setCatalogue] = useState<Awaited<ReturnType<typeof connections.catalogue>> | null>(null);
  const [encryption, setEncryption] = useState(true);
  const [params, setParams] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  /** The vendor being signed in to in the default browser (desktop app), and whether it was already connected. */
  const [inBrowser, setInBrowser] = useState<string | null>(null);
  const wasConnected = useRef(false);

  const load = useCallback(() => {
    connections
      .list()
      .then((r) => {
        setList(r.connections);
        setEncryption(r.encryptionConfigured);
      })
      .catch(() => setList([]));
    connections.catalogue().then(setCatalogue).catch(() => setCatalogue({ categories: {}, entries: [], unavailable: [], encryptionConfigured: true }));
  }, []);
  useEffect(load, [load]);

  // Signing in in the default browser (ADR 0033): pick the result up on the way back.
  useEffect(() => {
    if (!inBrowser) return;
    const done = catalogue?.entries.find((e) => e.id === inBrowser);
    if (done?.connected && done.status === 'ok' && !wasConnected.current) {
      setInBrowser(null);
      setParams({ connected: inBrowser }, { replace: true });
      return;
    }
    const back = () => load();
    window.addEventListener('focus', back);
    return () => window.removeEventListener('focus', back);
  }, [inBrowser, load, catalogue, setParams]);

  // Back from a vendor's sign-in: say how it went, then tidy the address bar.
  const connected = params.get('connected');
  const failed = params.get('error');
  const connectedName = catalogue?.entries.find((e) => e.id === connected)?.name ?? connected;

  const connect = async (entry: string, fields?: Record<string, string>) => {
    setError(null);
    try {
      if (inDesktopApp()) {
        // The app opens this one link in the default browser and stays here.
        const { handoffUrl } = await connections.startHandoff(entry, fields);
        const before = catalogue?.entries.find((e) => e.id === entry);
        wasConnected.current = !!before?.connected && before.status === 'ok';
        setInBrowser(entry);
        window.location.href = handoffUrl;
        return;
      }
      const { authorizeUrl } = await connections.startOAuth(entry, fields);
      window.location.href = authorizeUrl;
    } catch (err) {
      setError((err as Error).message);
    }
  };

  // Search and category chips: everything is filtered on the page; the catalogue is small enough to send whole.
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const categories = catalogue?.categories ?? {};
  const matches = (e: { name: string; category: string; keywords: string[]; description?: string; connectionName?: string | null }) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [e.name, categories[e.category] ?? e.category, e.description ?? '', e.connectionName ?? '', ...e.keywords]
      .some((field) => field.toLowerCase().includes(q));
  };
  const found = {
    entries: (catalogue?.entries ?? []).filter(matches),
    unavailable: (catalogue?.unavailable ?? []).filter(matches),
  };
  const chips = Object.entries(categories)
    .map(([key, name]) => ({
      key,
      name,
      count: found.entries.filter((e) => e.category === key).length + found.unavailable.filter((e) => e.category === key).length,
    }))
    .filter((c) => c.count > 0 || c.key === category);
  const byCategory = Object.entries(categories)
    .filter(([key]) => !category || key === category)
    .map(([key, name]) => ({
      key,
      name,
      entries: found.entries.filter((e) => e.category === key),
      unavailable: found.unavailable.filter((e) => e.category === key),
    }))
    .filter((c) => c.entries.length + c.unavailable.length > 0);
  const logoOf = (entry: string | null) =>
    [...(catalogue?.entries ?? []), ...(catalogue?.unavailable ?? [])].find((e) => e.id === entry)?.logo ?? null;

  return (
    <div className="page">
      <main className="column">
        <h1>Personal integrations</h1>
        <p className="muted">
          Your own connections. Calls made with them run as you — your account is what the vendor's audit log names.
          Attach one to a session from that session's Setup.
        </p>

        {(connected || failed) && (
          <p className={connected ? 'notice ok' : 'notice danger-hint'} role="status">
            {connected ? `Connected to ${connectedName}.` : `Couldn't connect: ${failed}`}{' '}
            <button className="link small" onClick={() => setParams({}, { replace: true })}>
              Dismiss
            </button>
          </p>
        )}

        {inBrowser && (
          <p className="notice" role="status">
            Finish signing in to {catalogue?.entries.find((e) => e.id === inBrowser)?.name ?? inBrowser} in your browser, then
            come back here.{' '}
            <button className="link small" onClick={() => setInBrowser(null)}>
              Dismiss
            </button>
          </p>
        )}

        {!encryption && (
          <p className="hint danger-hint">
            <code>FABRIKKA_ENCRYPTION_KEY</code> is not set, so tokens can't be stored. Connecting will be refused rather
            than saved in plaintext.
          </p>
        )}

        <h2>Your connections</h2>
        {list && list.length === 0 && <p className="muted small">No connections yet. Add one below.</p>}
        <ul className="connection-list">
          {list?.map((c) => (
            <li key={c.id} className="connection-row">
              <VendorMark logo={logoOf(c.entry)} name={c.label} />
              <span className="connection-text">
                <span className="connection-name">
                  <strong>{c.label}</strong>
                  {c.status === 'needs_reconnect' ? (
                    <span className="badge-shared">needs reconnecting</span>
                  ) : (
                    <span className="badge-ok">connected</span>
                  )}
                </span>
                <span className="muted small">
                  {c.auth === 'oauth'
                    ? 'signed in with the vendor'
                    : c.auth === 'basic'
                      ? 'email + API token stored'
                      : c.hasCredential
                        ? 'token stored'
                        : 'no token'}{' '}
                  · in {c.sessions} session{c.sessions === 1 ? '' : 's'}
                </span>
              </span>
              {c.status === 'needs_reconnect' && c.entry && (
                <button className="small" onClick={() => connect(c.entry!)}>
                  Reconnect
                </button>
              )}
              <button
                className="link small danger"
                title={c.sessions ? `Also removes it from ${c.sessions} session${c.sessions === 1 ? '' : 's'}` : undefined}
                onClick={async () => {
                  await connections.remove(c.slug).catch(() => {});
                  load();
                }}
              >
                Remove{c.sessions ? ` (from ${c.sessions} session${c.sessions === 1 ? '' : 's'})` : ''}
              </button>
            </li>
          ))}
        </ul>

        <h2>Add a connection</h2>
        <div className="catalogue-tools">
          <label className="catalogue-search">
            <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-3.5-3.5" />
            </svg>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search integrations"
              aria-label="Search integrations"
            />
          </label>
          <div className="chips" role="group" aria-label="Category">
            <button className={`chip${category === null ? ' on' : ''}`} aria-pressed={category === null} onClick={() => setCategory(null)}>
              All
            </button>
            {chips.map((c) => (
              <button
                key={c.key}
                className={`chip${category === c.key ? ' on' : ''}`}
                aria-pressed={category === c.key}
                onClick={() => setCategory(category === c.key ? null : c.key)}
              >
                {c.name} <span className="chip-count">{c.count}</span>
              </button>
            ))}
          </div>
        </div>

        {catalogue && (catalogue.entries.length + catalogue.unavailable.length === 0) && (
          <p className="muted small">No vendors are listed on this server yet. Use a custom connection below.</p>
        )}
        {catalogue && catalogue.entries.length + catalogue.unavailable.length > 0 && byCategory.length === 0 && (
          <div className="catalogue-empty">
            <p className="muted">
              Nothing matches{query.trim() ? <> “{query.trim()}”</> : ' this category'}.
            </p>
            <button className="small" onClick={() => setCustomOpen(true)}>
              Add it as a custom connection
            </button>
          </div>
        )}
        {byCategory.map((cat) => (
          <section key={cat.key} className="catalogue-category">
            <h3 className="subhead">{cat.name}</h3>
            <div className="catalogue-grid">
              {cat.entries.map((e) => (
                <CatalogueCard key={e.id} entry={e} onConnect={connect} />
              ))}
              {cat.unavailable.map((u) => (
                // Not hidden: say what this server is missing, so whoever runs it knows what to set.
                <div key={u.id} className="catalogue-card unavailable">
                  <div className="catalogue-head">
                    <VendorMark logo={u.logo} name={u.name} />
                    <strong>{u.name}</strong>
                    <span className="badge">not set up on this server</span>
                  </div>
                  <p className="muted small">
                    Whoever runs this server needs to add {u.missing.map((m) => <code key={m}>{m}</code>).reduce<React.ReactNode[]>((acc, el, i) => (i ? [...acc, ' and ', el] : [el]), [])}{' '}
                    (see “Connections by vendor” in docs/operations.md).
                  </p>
                </div>
              ))}
            </div>
          </section>
        ))}
        {error && <p className="error">{error}</p>}

        <details className="custom-connection" open={customOpen} onToggle={(e) => setCustomOpen(e.currentTarget.open)}>
          <summary className="muted small">Custom connection (any MCP server, by URL and token)</summary>
          <CustomConnection onSaved={load} />
        </details>
      </main>
    </div>
  );
}

/** One vendor: Connect, or what's needed first (a field), or that it's connected. */
function CatalogueCard({ entry, onConnect }: { entry: CatalogueItem; onConnect: (id: string, fields?: Record<string, string>) => void }) {
  const [fields, setFields] = useState<Record<string, string>>({});
  const [asking, setAsking] = useState(false);
  const needsFields = entry.fields.length > 0;
  const ready = entry.fields.every((f) => !f.required || fields[f.key]?.trim());

  return (
    <div className="catalogue-card">
      <div className="catalogue-head">
        <VendorMark logo={entry.logo} name={entry.name} />
        <strong>{entry.name}</strong>
        {entry.connected && entry.status === 'ok' && <span className="badge-ok">connected</span>}
        {entry.status === 'needs_reconnect' && <span className="badge-shared">needs reconnecting</span>}
      </div>
      <p className="muted small">
        {entry.description}
        {entry.connectionName && ` One ${entry.connectionName} connection covers it.`}
      </p>
      {asking &&
        entry.fields.map((f) => (
          <input
            key={f.key}
            id={`field-${entry.id}-${f.key}`}
            value={fields[f.key] ?? ''}
            placeholder={f.placeholder || f.label}
            aria-label={f.label}
            onChange={(e) => setFields((x) => ({ ...x, [f.key]: e.target.value }))}
          />
        ))}
      <button
        className={entry.connected && entry.status === 'ok' ? 'small' : 'primary small'}
        disabled={asking && !ready}
        onClick={() => (needsFields && !asking ? setAsking(true) : onConnect(entry.id, fields))}
      >
        {entry.connected ? 'Reconnect' : asking ? `Connect ${entry.name}` : 'Connect'}
      </button>
    </div>
  );
}

/** A vendor's logo on a white tile, or its initial when there's none (custom connections). */
function VendorMark({ logo, name }: { logo: VendorLogo | null; name: string }) {
  return (
    <span className={logo ? 'vendor-mark' : 'vendor-mark monogram'} aria-hidden="true">
      {logo ? (
        <svg viewBox="0 0 24 24" width="20" height="20">
          <path d={logo.path} fill={logo.color} />
        </svg>
      ) : (
        (name.trim()[0] ?? '?').toUpperCase()
      )}
    </span>
  );
}

function CustomConnection({ onSaved }: { onSaved: () => void }) {
  const [slug, setSlug] = useState('');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  // Basic: some vendors take a personal API token only with your email (Atlassian's).
  const [scheme, setScheme] = useState<'bearer' | 'basic'>('bearer');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          await connections.save({
            slug: slug.trim(),
            url: url.trim(),
            credential: token || undefined,
            username: scheme === 'basic' ? email.trim() : undefined,
          });
          setSlug('');
          setUrl('');
          setToken('');
          setEmail('');
          onSaved();
        } catch (err) {
          setError((err as Error).message);
        }
      }}
    >
      <input value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="name, e.g. sentry" aria-label="Connection name" />
      <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" aria-label="MCP server URL" />
      <Select
        label="Sign in with"
        value={scheme}
        options={[
          { value: 'bearer', label: 'A token', description: 'Sent as a Bearer token: GitHub, most servers' },
          { value: 'basic', label: 'Email + API token', description: "Sent as Basic: Atlassian's personal API tokens" },
        ]}
        onChange={(v) => setScheme(v)}
      />
      {scheme === 'basic' && (
        <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your email at that vendor" type="email" autoComplete="off" aria-label="Email" />
      )}
      <input
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={scheme === 'basic' ? 'API token' : 'token (yours; optional)'}
        type="password"
        autoComplete="off"
        aria-label={scheme === 'basic' ? 'API token' : 'Token'}
      />
      <button type="submit" disabled={!slug.trim() || !url.trim() || (scheme === 'basic' && (!email.trim() || !token))}>
        Save connection
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  );
}
