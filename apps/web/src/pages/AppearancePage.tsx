/**
 * Appearance (M44, ADR 0038): the themes this instance offers, as cards drawn
 * from their swatches. One click applies one, for this account, everywhere.
 */
import { useState } from 'react';
import type { ThemeInfo } from '../api.ts';
import { chooseTheme, useThemes } from '../themes.ts';
import { askPermission, permission, setShowsText, showsText } from '../notify.ts';

/** M42: per device, because a shared screen and a laptop want different answers. */
function DeviceNotifications() {
  const [perm, setPerm] = useState(permission);
  const [text, setText] = useState(showsText);
  return (
    <section aria-label="Notifications on this device">
      <h2>Notifications on this device</h2>
      {perm === 'granted' && <p className="muted small">On. A room that needs you notifies here, unless you're looking at it.</p>}
      {perm === 'default' && (
        <p className="muted small">
          Off. <button className="link small" onClick={async () => setPerm(await askPermission())}>Turn on</button>
        </p>
      )}
      {perm === 'denied' && <p className="muted small">Blocked in this browser's site settings. Allow notifications there to get them.</p>}
      {perm === 'unsupported' && <p className="muted small">This browser can't show notifications.</p>}
      <label className="check">
        <input
          type="checkbox"
          checked={text}
          onChange={(e) => {
            setShowsText(e.target.checked);
            setText(e.target.checked);
          }}
        />{' '}
        Show message text in notifications
      </label>
    </section>
  );
}

/** A small picture of the theme, drawn from its swatches: page, panel, accent, then the rest. */
function Preview({ swatches }: { swatches: string[] }) {
  const [bg, panel, accent, ...rest] = swatches;
  return (
    <span className="theme-preview" aria-hidden style={{ background: bg }}>
      <span className="theme-preview-side" style={{ background: panel }} />
      <span className="theme-preview-body">
        <span className="theme-preview-bar" style={{ background: accent }} />
        <span className="theme-preview-line" style={{ background: panel }} />
        <span className="theme-preview-line short" style={{ background: panel }} />
        <span className="theme-preview-dots">
          {rest.map((c) => (
            <span key={c} style={{ background: c }} />
          ))}
        </span>
      </span>
    </span>
  );
}

function ThemeCard({ theme, on, onPick }: { theme: ThemeInfo; on: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`theme-card${on ? ' on' : ''}`} aria-pressed={on} onClick={onPick}>
      <Preview swatches={theme.swatches} />
      <span className="theme-card-text">
        <strong>{theme.name}</strong>
        <span className="muted small">{theme.description}</span>
        {!theme.builtIn && <span className="muted small">Added by this instance{theme.author ? ` · ${theme.author}` : ''}</span>}
      </span>
    </button>
  );
}

export function AppearancePage() {
  const { offered, choice, showing } = useThemes();
  const [error, setError] = useState<string | null>(null);
  const pick = (id: string | null) => {
    setError(null);
    chooseTheme(id).catch((err) => setError((err as Error).message));
  };
  const light = offered?.find((t) => t.id === 'dusk');
  const dark = offered?.find((t) => t.id === 'dusk-night');

  return (
    <main className="column">
      <h1>Appearance</h1>
      <p className="muted">
        Your theme follows your account to every browser and the desktop app. Anyone can make one:{' '}
        <a href="https://github.com/fabrikkadotxyz/core/blob/main/docs/themes.md" target="_blank" rel="noreferrer noopener">
          how themes work
        </a>
        .
      </p>
      {error && <p className="error">{error}</p>}
      {!offered ? (
        <p className="muted">Loading themes…</p>
      ) : (
        <div className="theme-grid" role="group" aria-label="Themes">
          {light && dark && (
            <button type="button" className={`theme-card${choice === 'system' ? ' on' : ''}`} aria-pressed={choice === 'system'} onClick={() => pick('system')}>
              <span className="theme-preview theme-preview-split" aria-hidden>
                <Preview swatches={light.swatches} />
                <Preview swatches={dark.swatches} />
              </span>
              <span className="theme-card-text">
                <strong>Match my system</strong>
                <span className="muted small">Dusk in light mode, Dusk Night in dark mode.</span>
              </span>
            </button>
          )}
          {offered.map((t) => (
            <ThemeCard key={t.id} theme={t} on={choice !== 'system' && showing === t.id} onPick={() => pick(t.id === 'dusk' ? null : t.id)} />
          ))}
        </div>
      )}
      <DeviceNotifications />
    </main>
  );
}
