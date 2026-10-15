/**
 * Settings (2026-10-14, reshaped in M51 by ADR 0048): what a person configures
 * that is not a connection. People (for the organization chosen in the
 * switcher), Your devices, Appearance. The list beside the icon rail is the
 * navigation; each page has its own address, so a notice or a doc can point at
 * one. The integrations tabs this screen used to have forward to /integrations,
 * keeping their query.
 */
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { useWorkspace } from '../shell/workspace.tsx';
import { OrganizationPeople } from './TeamPage.tsx';
import { Devices } from './DevicesPage.tsx';
import { Appearance } from './AppearancePage.tsx';

const TABS = [
  { key: 'people', label: 'People', org: true },
  { key: 'devices', label: 'Your devices', org: false },
  { key: 'appearance', label: 'Appearance', org: false },
] as const;

export function SettingsPage() {
  const { tab } = useParams();
  const { search } = useLocation();
  const { team, loaded } = useWorkspace();
  if (tab === 'integrations') return <Navigate to={`/integrations${search}`} replace />;
  if (tab === 'organization') return <Navigate to={`/integrations/organization${search}`} replace />;
  const offered = TABS.filter((t) => !t.org || team);
  const current = offered.find((t) => t.key === tab);
  if (!current) {
    // People before the organizations are listed: wait rather than forward away from it.
    if (!loaded && TABS.some((t) => t.key === tab)) return <main className="centered">Loading…</main>;
    return <Navigate to={`/settings/${offered[0]!.key}${search}`} replace />;
  }

  return (
    <div className="page">
      <main className="column">
        <h1>{current.key === 'people' && team ? `People in ${team.name}` : current.label}</h1>
        {current.key === 'people' && team && <OrganizationPeople teamId={team.id} />}
        {current.key === 'devices' && <Devices />}
        {current.key === 'appearance' && <Appearance />}
      </main>
    </div>
  );
}
