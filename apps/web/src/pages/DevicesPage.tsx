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

/** The computer the browser is on (M57): the line shown first. */
const browserOs = (): 'unix' | 'windows' => (/Windows/i.test(navigator.userAgent) ? 'windows' : 'unix');

/**
 * M33 (ADR 0030): this instance's own installer. Once per computer, so a paste
 * here is the one-time setup the five-click rule allows. M57 (ADR 0056): the
 * line for the computer you are on, macOS and Linux or Windows, with a switch.
 */
export function ConnectCommand({ first }: { first: boolean }) {
  const [commands, setCommands] = useState<{ unix: string; windows: string | null } | null | undefined>(undefined);
  const [os, setOs] = useState<'unix' | 'windows'>(browserOs);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    client
      .get()
      .then((r) => setCommands(r.installCommand ? { unix: r.installCommand, windows: r.installCommandWindows ?? null } : null))
      .catch(() => setCommands(null));
  }, []);
  if (commands === undefined) return null;
  if (commands === null) {
    return <p className="muted small">This server has no client to install. Whoever runs it can build one with <code>pnpm build</code>.</p>;
  }
  const command = os === 'windows' && commands.windows ? commands.windows : commands.unix;
  return (
    <div className="card-hint">
      <p>
        <strong>{first ? 'Run your agents on your own computer.' : 'Connect another computer.'}</strong> Once, in a terminal on
        that computer:
      </p>
      {commands.windows && (
        <div className="os-switch" role="tablist" aria-label="Which computer">
          <button type="button" role="tab" aria-selected={os === 'unix'} className={`chip${os === 'unix' ? ' on' : ''}`} onClick={() => setOs('unix')}>
            macOS · Linux
          </button>
          <button type="button" role="tab" aria-selected={os === 'windows'} className={`chip${os === 'windows' ? ' on' : ''}`} onClick={() => setOs('windows')}>
            Windows
          </button>
        </div>
      )}
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
      {os === 'windows' && commands.windows ? (
        <p className="muted small">
          In PowerShell. It installs the Fabrikka app for your user (no Node, no admin rights), pointed at this site, and opens it. Then
          grant a folder in its Folders window, and use Setup → Add my agent in any session.
        </p>
      ) : (
        <p className="muted small">
          It needs Node.js 22 or newer, installs <code>fabrikka</code> in your home folder (no admin rights), then opens
          this site to connect: one click. Then grant a folder in the window it opens, and use Setup → Add my agent in
          any session. Add <code>-s -- --app</code> at the end to install the desktop app instead (no Node needed).
        </p>
      )}
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
      <AgentChoice picked={agents} onPick={(id) => save(agents.includes(id) ? agents.filter((a) => a !== id) : [...agents, id])} />
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
    // Nobody is looking at a hidden tab: poll only while visible, and catch up on return.
    const t = setInterval(() => document.visibilityState === 'visible' && load(), 5000);
    const onShow = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onShow);
    };
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
