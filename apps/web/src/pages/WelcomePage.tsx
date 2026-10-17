/**
 * The welcome (M47, amended 2026-10-16 and 2026-10-17): once per account, two
 * screens. First "Which agents do you use?", one narrow list, a row per tool
 * in the registry with its logo and a checkbox, any number ticked, plus
 * "something else"; below it, one field for the agents not run yet that you
 * would want, growing a chip per name, with the known names suggested as you
 * type. The choices shape Add my agent, Connect another way,
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

/**
 * The registry's tools and "something else", as one narrow list (the owner's
 * pick of three, 2026-10-17): a checkbox, the logo, the name, a hairline
 * between rows. No blurbs: the name and the mark are the whole row. Any
 * number ticked.
 */
export function AgentChoice({ picked, onPick }: { picked: string[]; onPick: (id: string) => void }) {
  const row = (id: string, name: string) => {
    const on = picked.includes(id);
    return (
      <label key={id} className={`agent-row${on ? ' on' : ''}${id === 'other' ? ' other' : ''}`}>
        <input type="checkbox" checked={on} onChange={() => onPick(id)} />
        <AgentLogo id={id} name={name} size={22} />
        <span>{name}</span>
      </label>
    );
  };
  return (
    <div className="agent-list" role="group" aria-label="Which agents do you use?">
      {AGENT_TOOLS.map((t) => row(t.id, t.name))}
      {row('other', 'Something else, or none yet')}
    </div>
  );
}

/**
 * Agents Fabrikka does not run yet: one field that grows a chip per wish as
 * you type, with the known names suggested as you go; a name none of them
 * match is kept as typed.
 */
export function WantedChoice({ picked, onChange }: { picked: string[]; onChange: (wanted: string[]) => void }) {
  const [text, setText] = useState('');
  const nameOf = (w: string) => WANTED_AGENTS.find((x) => x.id === w)?.name ?? w;
  const q = text.trim().toLowerCase();
  const suggestions = WANTED_AGENTS.filter((w) => !picked.includes(w.id) && (q === '' || w.name.toLowerCase().includes(q)));
  const full = picked.length >= WANTED_MAX;
  const add = (w: string) => {
    const t = w.trim().slice(0, WANTED_NAME_MAX);
    if (!t || picked.includes(t) || full) return;
    onChange([...picked, t]);
    setText('');
  };
  const remove = (w: string) => onChange(picked.filter((x) => x !== w));
  const submit = () => {
    if (!q) return;
    // A typed name that matches a known one, or its id, is that one.
    const known = WANTED_AGENTS.find((w) => w.name.toLowerCase() === q || w.id === q) ?? (suggestions.length === 1 ? suggestions[0] : undefined);
    add(known ? known.id : text);
  };
  return (
    <div className="wanted">
      <label htmlFor="wanted-input" className="wanted-q">
        Others you’d want Fabrikka to run
      </label>
      <div className="wanted-box">
        {picked.map((w) => (
          <span key={w} className="chip on">
            {nameOf(w)}
            <button type="button" className="chip-x" aria-label={`Remove ${nameOf(w)}`} onClick={() => remove(w)}>
              ×
            </button>
          </span>
        ))}
        <input
          id="wanted-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              submit();
            } else if (e.key === 'Backspace' && text === '' && picked.length > 0) remove(picked[picked.length - 1]!);
          }}
          maxLength={WANTED_NAME_MAX}
          placeholder={picked.length ? '' : 'type a name…'}
          disabled={full}
          aria-label="Another agent you would want"
        />
      </div>
      {q !== '' && suggestions.length > 0 && (
        <div className="chips wanted-suggest" aria-label="Suggestions">
          {suggestions.map((w) => (
            <button key={w.id} type="button" className="chip" onClick={() => add(w.id)}>
              {w.name}
            </button>
          ))}
        </div>
      )}
      {q === '' && suggestions.length > 0 && <p className="muted small wanted-hint">Suggestions as you type: {suggestions.map((w) => w.name).join(' · ')}</p>}
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
        <div className="welcome-narrow">
          <AgentChoice picked={agents} onPick={toggleAgent} />
          <WantedChoice picked={wanted} onChange={setWanted} />
        </div>
        <div className="welcome-actions">
          <button className="primary" onClick={() => setStep('look')}>
            Continue
          </button>
          <span className="muted small">change any time</span>
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
