/**
 * Appearance (M44, ADR 0038): the themes this instance offers, as cards drawn
 * from their swatches. One click applies one, for this account, everywhere.
 */
import { useState } from 'react';
import type { ThemeInfo } from '../api.ts';
import { chooseTheme, useThemes } from '../themes.ts';

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
  const system = offered?.filter((t) => t.id === 'dusk' || t.id === 'dusk-night') ?? [];

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
          {system.length === 2 && (
            <button type="button" className={`theme-card${choice === 'system' ? ' on' : ''}`} aria-pressed={choice === 'system'} onClick={() => pick('system')}>
              <span className="theme-preview theme-preview-split" aria-hidden>
                <Preview swatches={system[0].swatches} />
                <Preview swatches={system[1].swatches} />
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
    </main>
  );
}
