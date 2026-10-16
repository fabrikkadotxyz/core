/**
 * The welcome (M47, amended 2026-10-16): once per account, two screens. First
 * "Which agent do you use?", one card per tool in the registry and "something
 * else"; the choice shapes Add my agent, Connect another way, Get started and
 * Your devices, and is never a restriction. Then "Pick a look": choosing
 * previews it here; Continue saves both to the account and goes on to
 * wherever the person was headed.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AGENT_TOOLS } from '@fabrikka/types';
import { onboarding } from '../api.ts';
import { markWelcomedLocally, refreshOnboarding } from '../onboarding.ts';
import { previewTheme, useThemes } from '../themes.ts';
import { ThemePicker } from './AppearancePage.tsx';

/** What each tool is, in a line, for someone choosing. */
const BLURB: Record<string, string> = {
  'claude-code': 'Anthropic’s terminal agent. Fabrikka can also follow a live session.',
  codex: 'OpenAI’s terminal agent. Confines writes in a folder, not reads.',
  opencode: 'The open-source terminal agent. Confined fully; free models by default.',
  antigravity: 'Google’s terminal agent. Confined fully; the room’s tools in Full folders.',
};

export function AgentChoice({ picked, onPick }: { picked: string | null; onPick: (id: string | null) => void }) {
  return (
    <div className="agent-cards" role="radiogroup" aria-label="Which agent do you use?">
      {AGENT_TOOLS.map((t) => (
        <button key={t.id} type="button" role="radio" aria-checked={picked === t.id} className={`agent-card${picked === t.id ? ' on' : ''}`} onClick={() => onPick(t.id)}>
          <strong>{t.name}</strong>
          <span className="muted small">{BLURB[t.id] ?? `Runs as ${t.command}.`}</span>
        </button>
      ))}
      <button type="button" role="radio" aria-checked={picked === 'other'} className={`agent-card${picked === 'other' ? ' on' : ''}`} onClick={() => onPick('other')}>
        <strong>Something else, or none yet</strong>
        <span className="muted small">Any MCP client can join a room; you can pick a tool later.</span>
      </button>
    </div>
  );
}

export function WelcomePage() {
  const { offered } = useThemes();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [step, setStep] = useState<'agent' | 'look'>('agent');
  const [agent, setAgent] = useState<string | null>(null);
  // The default (Fabrikka), preselected: null is "no choice", which is the default.
  const [picked, setPicked] = useState<string | null>(null);
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
      await onboarding.welcome(picked, agent ?? 'other');
      markWelcomedLocally();
      refreshOnboarding().catch(() => {});
      navigate(from && from !== '/welcome' ? from : '/', { replace: true });
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  if (step === 'agent') {
    return (
      <main className="column welcome">
        <h1>Welcome to Fabrikka. Which agent do you use?</h1>
        <p className="muted">Fabrikka runs it in rooms, on your computer. This only sets what comes first; every installed tool stays offered.</p>
        <AgentChoice picked={agent} onPick={setAgent} />
        <div className="welcome-actions">
          <button className="primary" onClick={() => setStep('look')}>
            Continue
          </button>
          <span className="muted small">Change it any time in Your devices.</span>
        </div>
      </main>
    );
  }

  return (
    <main className="column welcome">
      <h1>Pick a look.</h1>
      {error && <p className="error">{error}</p>}
      {!offered ? <p className="muted">Loading themes…</p> : <ThemePicker offered={offered} selected={picked} onPick={pick} />}
      <div className="welcome-actions">
        <button className="primary" onClick={go} disabled={busy}>
          Continue
        </button>
        <button className="link small" onClick={() => setStep('agent')}>
          Back
        </button>
        <span className="muted small">Change it any time in Appearance.</span>
      </div>
    </main>
  );
}
