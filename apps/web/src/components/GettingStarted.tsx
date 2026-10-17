/**
 * Get started (M47): five steps on the home page, each ticked from the record
 * (never stored) and each one click from its page. It checks again every few
 * seconds while open, so pairing a computer ticks without a reload.
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { onboarding, sessions, type GettingStartedStep } from '../api.ts';
import { AGENT_TOOLS, agentTool } from '@fabrikka/types';

/** The first registry tool among the ones they said they use (2026-10-17: several). */
const firstTool = (agents: string[] | null) => agents?.map(agentTool).find((t) => t) ?? undefined;
import { useOnboarding } from '../onboarding.ts';
import { useWorkspace } from '../shell/workspace.tsx';

const POLL_MS = 5000;
const LABELS: Record<GettingStartedStep, { title: string; hint: string }> = {
  computer: { title: 'Connect your computer', hint: 'Your agents run there, with your tools and your folders.' },
  room: { title: 'Start a room', hint: 'Where you, your colleagues and your agents work together.' },
  agent: { title: 'Bring your agent', hint: `${AGENT_TOOLS.map((t) => t.name).join(', ')}, on your computer, in the room.` },
  invite: { title: 'Invite a colleague', hint: 'They see what your agent did, and can mention it too.' },
  integration: { title: 'Connect GitHub or Jira', hint: 'So agents can read issues and pull requests.' },
};

export function GettingStarted() {
  const { state, refresh } = useOnboarding();
  const { team, refresh: refreshWorkspace } = useWorkspace();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const required = state?.steps.filter((s) => !s.optional) ?? [];
  const finished = required.length > 0 && required.every((s) => s.done);
  const open = !!state && !state.dismissed && !finished;

  useEffect(() => {
    if (!open) return;
    refresh().catch(() => {});
    const t = setInterval(() => document.visibilityState === 'visible' && refresh().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [open, refresh]);

  if (!state || !open) return null;
  const done = (id: GettingStartedStep) => state.steps.find((s) => s.id === id)?.done ?? false;
  const next = state.steps.find((s) => !s.done)?.id;

  const startRoom = async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await sessions.create('My first room', team?.id);
      refreshWorkspace();
      refresh().catch(() => {});
      navigate(`/o/${s.ownerSlug}/s/${s.publicId}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const action = (id: GettingStartedStep) => {
    switch (id) {
      case 'computer':
        return <Link className="button" to="/settings/devices">Connect</Link>;
      case 'room':
        return <button onClick={startRoom} disabled={busy}>Start</button>;
      case 'agent':
        if (!done('computer') || !state.room) {
          return <span className="muted small">{!done('computer') ? 'Connect your computer first' : 'Start a room first'}</span>;
        }
        return <Link className="button" to={`/o/${state.room.ownerSlug}/s/${state.room.publicId}?add-agent=1`}>Add</Link>;
      case 'invite':
        if (team) return <Link className="button" to="/settings/people">Invite</Link>;
        if (state.room) return <Link className="button" to={`/o/${state.room.ownerSlug}/s/${state.room.publicId}`}>Invite</Link>;
        return <span className="muted small">Start a room first</span>;
      case 'integration':
        return <Link className="button" to="/integrations">Connect</Link>;
    }
  };

  return (
    <section className="getting-started" aria-label="Get started">
      <header>
        <h2>Get started</h2>
        <button
          className="link small"
          onClick={() => onboarding.dismiss().then(() => refresh()).catch((err) => setError((err as Error).message))}
        >
          Dismiss
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      <ol>
        {state.steps.map((s, i) => (
          <li key={s.id} className={s.done ? 'done' : s.id === next ? 'next' : undefined}>
            <span className="step-mark" aria-hidden>{s.done ? '✓' : i + 1}</span>
            <span className="step-text">
              <strong>
                {s.id === 'agent' && firstTool(state.agents) ? `Bring ${firstTool(state.agents)!.name}` : LABELS[s.id].title}
                {s.optional && <span className="muted small"> (optional)</span>}
              </strong>
              <span className="muted small">{LABELS[s.id].hint}</span>
            </span>
            <span className="step-action">{s.done ? <span className="muted small">Done</span> : action(s.id)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
