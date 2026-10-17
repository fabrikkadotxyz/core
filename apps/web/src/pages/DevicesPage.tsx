/**
 * Your devices (M31): the computers paired with your account, the folders each
 * has granted (labels only — paths never leave the machine), and revoking one.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DeviceSummary } from '@fabrikka/types';
import { client, devices } from '../api.ts';
import { inDesktopApp, openFolders } from '../desktop.ts';
import { onboarding } from '../api.ts';
import { useOnboarding } from '../onboarding.ts';
import { AgentChoice, WantedChoice } from './WelcomePage.tsx';
import { timeAgo } from '../outputs/Outputs.tsx';
import { useWorkspace } from '../shell/workspace.tsx';

/**
 * M33 (ADR 0030): this instance's own installer. Once per computer, so a paste
 * here is the one-time setup the five-click rule allows.
 */
export function ConnectCommand({ first }: { first: boolean }) {
  const [command, setCommand] = useState<string | null | undefined>(undefined);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    client.get().then((r) => setCommand(r.installCommand)).catch(() => setCommand(null));
  }, []);
  if (command === undefined) return null;
  if (command === null) {
    return <p className="muted small">This server has no client to install. Whoever runs it can build one with <code>pnpm build</code>.</p>;
  }
  return (
    <div className="card-hint">
      <p>
        <strong>{first ? 'Run your agents on your own computer.' : 'Connect another computer.'}</strong> Once, in a terminal on
        that computer:
      </p>
      <div className="row copy-row">
        <code className="endpoint">{command}</code>
        <button
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(command);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              // Clipboard refused: the command is selectable text.
            }
          }}
        >
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <p className="muted small">
        It needs Node.js 22 or newer, installs <code>fabrikka</code> in your home folder (no admin rights), then opens
        this site to connect: one click. Then grant a folder in the window it opens, and use Setup → Add my agent in
        any session.
      </p>
    </div>
  );
}

/** 2026-10-16: the agent you said you use at the welcome, changeable here. A preference, never a restriction. */
/** 2026-10-17: the same cards as the welcome, any number ticked, and the ones you wish for. */
function YourAgent() {
  const { state, refresh } = useOnboarding();
  if (!state) return null;
  const agents = state.agents ?? [];
  const save = (next: string[], wanted?: string[]) =>
    onboarding
      .setAgents(next, wanted)
      .then(() => refresh())
      .catch(() => {});
  return (
    <div className="your-agent">
      <h3 className="subhead">The agents you use</h3>
      <AgentChoice picked={agents} onPick={(id) => save(agents.includes(id) ? agents.filter((a) => a !== id) : [...agents, id])} compact />
      <WantedChoice picked={state.wanted} onChange={(w) => save(agents, w)} />
      <p className="muted small">The first comes first in Add my agent; every installed tool stays offered.</p>
    </div>
  );
}

export function Devices() {
  const [list, setList] = useState<DeviceSummary[] | null>(null);
  // ADR 0043: each folder is for one organization's rooms. Personal (M53, ADR 0051) serves no room any more.
  const { teams } = useWorkspace();
  const orgName = (id: string | null) => (id ? (teams.find((t) => t.id === id)?.name ?? 'an organization') : 'Personal · no longer used');
  const load = useCallback(() => {
    devices.list().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <>
    <YourAgent />
    <p className="muted">
      Computers that can run your agents. Each runs them only in folders granted on that computer, with the
      policy chosen there.
    </p>
    {/* M34: in the desktop app, its own Folders window — where folders are chosen, on this computer. */}
    {inDesktopApp() ? (
      <div className="card-hint">
        <p>
          <strong>Folders on this computer.</strong> Choose which folders your agents may work in, and how much
          they may do there.
        </p>
        <button onClick={() => openFolders().catch(() => {})}>Add folders…</button>
      </div>
    ) : (
      list !== null &&
      list.length > 0 && (
        <p className="muted small">
          Folders are chosen on each computer, never from this page: in the Fabrikka app (menu-bar icon →
          Folders…), or on the page <code>fabrikka host</code> opened.
        </p>
      )
    )}
    {list !== null && <ConnectCommand first={list.length === 0} />}
    <ul className="session-list">
      {list?.map((d) => (
        <li key={d.id} className="device">
          <div className="row">
            <span className={d.online ? 'status on' : 'status off'}>{d.online ? 'online' : 'offline'}</span>
            <strong>{d.name}</strong>
            <span className="muted small">{d.lastSeenAt ? `seen ${timeAgo(d.lastSeenAt)}` : ''}</span>
            <span className="spacer" />
            <button
              className="link small danger"
              onClick={async () => {
                if (!window.confirm(`Disconnect “${d.name}”? Its agents stop running until you connect it again.`)) return;
                await devices.revoke(d.id).catch(() => {});
                load();
              }}
            >
              disconnect
            </button>
          </div>
          {d.grants.length === 0 ? (
            <p className="muted small">No folders granted yet.</p>
          ) : (
            <ul className="grant-list">
              {d.grants.map((g) => (
                <li key={g.id}>
                  📁 {g.label} <span className="muted small">for {orgName(g.org)} · {g.providers.join(', ') || 'no agent tools found'}</span>
                  {!g.usable && <span className="muted small"> · no agent tool here can run from the host yet</span>}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
    </>
  );
}
