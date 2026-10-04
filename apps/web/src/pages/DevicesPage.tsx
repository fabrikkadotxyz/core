/**
 * Your devices (M31): the computers paired with your account, the folders each
 * has granted (labels only — paths never leave the machine), and revoking one.
 */
import { useCallback, useEffect, useState } from 'react';
import type { DeviceSummary } from '@fabrikka/types';
import { devices } from '../api.ts';
import { timeAgo } from '../outputs/Outputs.tsx';

export function DevicesPage() {
  const [list, setList] = useState<DeviceSummary[] | null>(null);
  const load = useCallback(() => {
    devices.list().then(setList).catch(() => setList([]));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="page">
      <main className="column">
        <h1>Your devices</h1>
        <p className="muted">
          Computers that can run your agents. Each runs them only in folders granted on that computer, with the
          policy chosen there.
        </p>
        {list?.length === 0 && (
          <div className="card-hint">
            <p>
              <strong>Run your agents on your own computer.</strong> Once, in a terminal on that computer:
            </p>
            <code className="endpoint">npx fabrikka host</code>
            <p className="muted small">
              It opens this site to connect (one click), then its own window where you grant folders. After that,
              adding your agent to a session is Setup → Add my agent.
            </p>
          </div>
        )}
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
                <p className="muted small">No folders granted yet — grant one in the host's window.</p>
              ) : (
                <ul className="grant-list">
                  {d.grants.map((g) => (
                    <li key={g.id}>
                      📁 {g.label} <span className="muted small">{g.providers.join(', ') || 'no agent tools found'}</span>
                      {!g.usable && <span className="muted small"> · no agent tool here can run from the host yet</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
