/**
 * The welcome (M47, amended 2026-10-16 and 2026-10-17): once per account, two
 * screens. First "Which agents do you use?", one card per tool in the registry
 * with its logo, any number ticked, plus "something else"; below it, "which
 * others would you want Fabrikka to run?", chips for agents not run yet and a
 * line for another name. The choices shape Add my agent, Connect another way,
 * Get started and Your devices, and are never a restriction; the wishes are
 * counted by the admin and say which adapter to build next. Then "Pick a look":
 * choosing previews it here; Continue saves everything to the account and goes
 * on to wherever the person was headed.
 */
import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AGENT_TOOLS, WANTED_AGENTS, WANTED_MAX, WANTED_NAME_MAX } from '@fabrikka/types';
import { onboarding } from '../api.ts';
import { AgentLogo } from '../components/AgentLogo.tsx';
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

/** The registry's tools and "something else", as cards; any number ticked. */
export function AgentChoice({ picked, onPick, compact = false }: { picked: string[]; onPick: (id: string) => void; compact?: boolean }) {
  const card = (id: string, name: string, blurb: string) => {
    const on = picked.includes(id);
    return (
      <button key={id} type="button" role="checkbox" aria-checked={on} className={`agent-card${on ? ' on' : ''}${compact ? ' compact' : ''}`} onClick={() => onPick(id)}>
        <span className="agent-card-head">
          <AgentLogo id={id} name={name} size={compact ? 22 : 28} />
          <strong>{name}</strong>
          <span className="agent-tick" aria-hidden>
            {on ? '✓' : ''}
          </span>
        </span>
        {!compact && <span className="muted small">{blurb}</span>}
      </button>
    );
  };
  return (
    <div className="agent-cards" role="group" aria-label="Which agents do you use?">
      {AGENT_TOOLS.map((t) => card(t.id, t.name, BLURB[t.id] ?? `Runs as ${t.command}.`))}
      {card('other', 'Something else, or none yet', 'Any MCP client can join a room; you can pick a tool later.')}
    </div>
  );
}

/** Agents Fabrikka does not run yet: chips to tick, and a line for another name. */
export function WantedChoice({ picked, onChange }: { picked: string[]; onChange: (wanted: string[]) => void }) {
  const [other, setOther] = useState('');
  const known = new Set<string>(WANTED_AGENTS.map((w) => w.id));
  const free = picked.filter((w) => !known.has(w));
  const toggle = (id: string) => onChange(picked.includes(id) ? picked.filter((w) => w !== id) : [...picked, id]);
  const addOther = () => {
    const t = other.trim().slice(0, WANTED_NAME_MAX);
    if (!t || picked.includes(t) || picked.length >= WANTED_MAX) return;
    onChange([...picked, t]);
    setOther('');
  };
  return (
    <div className="wanted" aria-label="Which others would you want Fabrikka to run?">
      <p className="wanted-q">Which others would you want Fabrikka to run?</p>
      <div className="chips">
        {WANTED_AGENTS.map((w) => (
          <button key={w.id} type="button" role="checkbox" aria-checked={picked.includes(w.id)} className={`chip wanted-chip${picked.includes(w.id) ? ' on' : ''}`} onClick={() => toggle(w.id)}>
            {w.name}
          </button>
        ))}
        {free.map((w) => (
          <button key={w} type="button" role="checkbox" aria-checked className="chip wanted-chip on" onClick={() => toggle(w)} title="Click to remove">
            {w}
          </button>
        ))}
      </div>
      <form
        className="wanted-other"
        onSubmit={(e) => {
          e.preventDefault();
          addOther();
        }}
      >
        <input value={other} onChange={(e) => setOther(e.target.value)} maxLength={WANTED_NAME_MAX} placeholder="Another one? Its name" aria-label="Another agent you would want" />
        <button type="submit" disabled={!other.trim() || picked.length >= WANTED_MAX}>
          Add
        </button>
      </form>
    </div>
  );
}

export function WelcomePage() {
  const { offered } = useThemes();
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from;
  const [step, setStep] = useState<'agent' | 'look'>('agent');
  const [agents, setAgents] = useState<string[]>([]);
  const [wanted, setWanted] = useState<string[]>([]);
  // The default (Fabrikka), preselected: null is "no choice", which is the default.
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleAgent = (id: string) => setAgents((prev) => (prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]));
  const pick = (id: string | null) => {
    setPicked(id);
    previewTheme(id);
  };
  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      previewTheme(picked);
      // Nothing ticked means "something else, or none yet".
      await onboarding.welcome(picked, agents.length > 0 ? agents : ['other'], wanted);
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
        <h1>Welcome to Fabrikka. Which agents do you use?</h1>
        <p className="muted">Fabrikka runs them in rooms, on your computer. Tick any number; this only sets what comes first, and every installed tool stays offered.</p>
        <AgentChoice picked={agents} onPick={toggleAgent} />
        <WantedChoice picked={wanted} onChange={setWanted} />
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
