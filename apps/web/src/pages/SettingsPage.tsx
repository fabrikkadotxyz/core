/**
 * Settings (2026-10-14): one screen, tabs. The sidebar is for rooms; everything
 * a person configures is here: Personal integrations, Organization integrations
 * and People (for the organization chosen in the sidebar's switcher, which is
 * why the tabs don't repeat its name), Your devices,
 * Appearance. Each tab has its own address, so a notice or a doc can point at
 * one, and the pages' old addresses forward here (App.tsx).
 */
import { Navigate, NavLink, useLocation, useParams } from 'react-router-dom';
import { useWorkspace } from '../shell/workspace.tsx';
import { PersonalIntegrations } from './IntegrationsPage.tsx';
import { OrganizationIntegrations } from './TeamIntegrationsPage.tsx';
import { OrganizationPeople } from './TeamPage.tsx';
import { Devices } from './DevicesPage.tsx';
import { Appearance } from './AppearancePage.tsx';

const TABS = [
  { key: 'integrations', label: 'Personal integrations', org: false },
  { key: 'organization', label: 'Organization integrations', org: true },
  { key: 'people', label: 'People', org: true },
  { key: 'devices', label: 'Your devices', org: false },
  { key: 'appearance', label: 'Appearance', org: false },
] as const;

export function SettingsPage() {
  const { tab } = useParams();
  const { search } = useLocation();
  const { team } = useWorkspace();
  const offered = TABS.filter((t) => !t.org || team);
  const current = offered.find((t) => t.key === tab);
  if (!current) return <Navigate to={`/settings/integrations${search}`} replace />;

  return (
    <div className="page">
      <main className="column">
        <h1>Settings</h1>
        <nav className="tabs settings-tabs" role="tablist" aria-label="Settings">
          {offered.map((t) => (
            <NavLink
              key={t.key}
              to={`/settings/${t.key}`}
              role="tab"
              aria-selected={t.key === current.key}
              className={({ isActive }) => (isActive ? 'tab on' : 'tab')}
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        {current.key === 'integrations' && <PersonalIntegrations />}
        {current.key === 'organization' && team && <OrganizationIntegrations teamId={team.id} />}
        {current.key === 'people' && team && <OrganizationPeople teamId={team.id} />}
        {current.key === 'devices' && <Devices />}
        {current.key === 'appearance' && <Appearance />}
      </main>
    </div>
  );
}
