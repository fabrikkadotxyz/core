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
import { Organizations } from './OrganizationsPage.tsx';
import { Account } from './AccountPage.tsx';
import { OrganizationActivity } from './ActivityPage.tsx';

const TABS = [
  // M68 (ADR 0062): not in Self, which is one person.
  { key: 'people', label: 'People', org: true, self: false, notSelf: true },
  // M60 (ADR 0058): who did what, for the organization's owners.
  { key: 'activity', label: 'Activity', org: true, self: false, notSelf: false },
  // 2026-10-16: organizations are made here, in Self only; the home is for what needs you.
  { key: 'organizations', label: 'Organizations', org: true, self: true, notSelf: false },
  { key: 'devices', label: 'Your devices', org: false, self: false, notSelf: false },
  { key: 'appearance', label: 'Appearance', org: false, self: false, notSelf: false },
  // M58 (ADR 0057): who you are, and the door out.
  { key: 'account', label: 'Account', org: false, self: false, notSelf: false },
] as const;

export function SettingsPage() {
  const { tab } = useParams();
  const { search } = useLocation();
  const { team, loaded } = useWorkspace();
  if (tab === 'integrations') return <Navigate to={`/integrations${search}`} replace />;
  if (tab === 'organization') return <Navigate to={`/integrations/organization${search}`} replace />;
  const offered = TABS.filter((t) => (!t.org || team) && (!t.self || team?.own) && (!t.notSelf || !team?.own));
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
        {current.key === 'activity' && team && <OrganizationActivity teamId={team.id} />}
        {current.key === 'organizations' && <Organizations />}
        {current.key === 'devices' && <Devices />}
        {current.key === 'appearance' && <Appearance />}
        {current.key === 'account' && <Account />}
      </main>
    </div>
  );
}
