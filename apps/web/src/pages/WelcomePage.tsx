/**
 * The welcome (M47): pick a look, once per account. Choosing previews it here;
 * Continue saves it to the account (the same setting as Appearance) and goes
 * on to wherever the person was headed.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { onboarding } from '../api.ts';
import { markWelcomedLocally } from '../onboarding.ts';
import { previewTheme, useThemes } from '../themes.ts';
import { ThemePicker } from './AppearancePage.tsx';

export function WelcomePage() {
  const { offered } = useThemes();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  // Match my system, preselected.
  const [picked, setPicked] = useState<string | null>('system');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pick = (id: string | null) => {
    setPicked(id);
    previewTheme(id);
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      previewTheme(picked);
      await onboarding.welcome(picked);
      markWelcomedLocally();
      navigate(from && from !== '/welcome' ? from : '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <main className="column welcome">
      <h1>Welcome to Fabrikka. Pick a look.</h1>
      {error && <p className="error">{error}</p>}
      {!offered ? <p className="muted">Loading themes…</p> : <ThemePicker offered={offered} selected={picked} onPick={pick} />}
      <div className="welcome-actions">
        <button className="primary" onClick={go} disabled={busy}>
          Continue
        </button>
        <span className="muted small">Change it any time in Appearance.</span>
      </div>
    </main>
  );
}
