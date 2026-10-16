/**
 * M46 fixture: a deployment that uses the gates (ADR 0041): an account cap, a
 * team it refuses writes in, and a notice. Used only by scripts/acceptance/m46.mjs.
 *
 *   - accounts: refused at FIXTURE_MAX_ACCOUNTS;
 *   - writes: refused in any team whose name starts with "Gated", or that
 *     POST /api/fixture/gate/:team switched on (ADR 0050: a room can no longer
 *     be moved into a gated team, so the check gates the room's own team);
 *   - notices: every team says how many members it has;
 *   - members: every change is recorded, readable at /api/fixture/members.
 */
import { createApp, type Extension } from '../../apps/server/src/lib.ts';

const MAX = Number(process.env.FIXTURE_MAX_ACCOUNTS ?? '0');
const changes: { teamId: string; members: number }[] = [];
const gated = new Set<string>();

const fixture: Extension = {
  name: 'fixture',
  mount(app, kit) {
    kit.guardNewAccounts(({ accounts }) => (MAX && accounts >= MAX ? 'Fixture is full: no new accounts.' : null));
    kit.guardWrites(async ({ teamId, action }) => {
      if (!teamId) return null;
      const team = await kit.team(teamId);
      return team?.name.startsWith('Gated') || gated.has(teamId) ? { reason: `Fixture gated this team (${action}).`, url: '/fixture-notice' } : null;
    });
    kit.teamNotice(async ({ teamId }) => {
      const team = await kit.team(teamId);
      return team ? { text: `${team.members} member(s)`, tone: 'info', url: '/fixture-notice' } : null;
    });
    kit.onTeamMembersChanged((change) => void changes.push(change));
    app.get('/api/fixture/members', (c) => c.json(changes));
    app.post('/api/fixture/gate/:team', (c) => {
      gated.add(c.req.param('team'));
      return c.json({ ok: true });
    });
    app.get('/api/fixture/role/:team/:user', async (c) => c.json({ role: await kit.teamRole(c.req.param('team'), c.req.param('user')) }));
  },
};

await createApp({ extensions: [fixture] }).start(Number(process.env.PORT));
