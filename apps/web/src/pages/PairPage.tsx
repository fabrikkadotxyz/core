/**
 * Connect a computer (M31, ADR 0027): the page the host opens. One click
 * confirms the code it shows, and the host gets its device token — once.
 */
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { devices } from '../api.ts';

export function PairPage() {
  const { code = '' } = useParams();
  const [state, setState] = useState<'loading' | 'ready' | 'invalid' | 'done'>('loading');
  const [deviceName, setDeviceName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    devices
      .pairing(code)
      .then((p) => {
        setDeviceName(p.deviceName);
        setState('ready');
      })
      .catch(() => setState('invalid'));
  }, [code]);

  return (
    <div className="page">
      <main className="column">
        {state === 'loading' && <p className="muted">Loading…</p>}
        {state === 'invalid' && (
          <>
            <h1>That code doesn't work</h1>
            <p className="muted">It may have expired (codes last ten minutes) or been used. Start the host again to get a new one.</p>
          </>
        )}
        {state === 'ready' && (
          <>
            <h1>Connect “{deviceName}”?</h1>
            <p>
              Check that this code matches the one on your computer: <strong className="pair-code">{code}</strong>
            </p>
            <p className="muted">
              Your agents will be able to run on that computer, but only in folders you grant there, in its own
              window, never from this site.
            </p>
            <button
              onClick={async () => {
                setError(null);
                try {
                  await devices.confirm(code);
                  setState('done');
                } catch (err) {
                  setError((err as Error).message);
                }
              }}
            >
              Connect this computer
            </button>
            {error && <p className="error">{error}</p>}
          </>
        )}
        {state === 'done' && (
          <>
            <h1>Connected</h1>
            <p>
              “{deviceName}” is connected. Grant a folder in its window, then in any session choose{' '}
              <strong>Setup → Add my agent</strong>.
            </p>
            <p>
              <Link to="/settings/devices">Your devices</Link>
            </p>
          </>
        )}
      </main>
    </div>
  );
}
