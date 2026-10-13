/**
 * The local host (M31, ADR 0027): paired machines that run your agents in folders
 * you granted on the machine itself.
 *
 * The server never holds a path or a policy. A device reports grants as opaque
 * ids with labels; a binding says "this session agent runs on that device, in
 * that grant". On every host connection each binding gets a fresh token (the old
 * one revoked), and the host opens an ordinary runner connection with it — so
 * delivery, runs, activity and the kill switch are exactly the runner's.
 */
import { randomBytes } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '@fabrikka/db';
import {
  agents,
  devicePairings,
  deviceGrants,
  devices,
  generateToken,
  hashToken,
  participants,
  sessionAgentHosts,
  sessionAgents,
  sessions,
  sessionTokens,
  teamMembers,
  teams,
  users,
} from '@fabrikka/db';
import { AGENT_TOOLS } from '@fabrikka/types';
import type { DeviceSummary } from '@fabrikka/types';
import { addAgentToSession } from './agents.ts';

const PAIRING_TTL_MS = 10 * 60_000;
/** Agent tools whose host policies were verified (ADR 0027). Codex isn't, yet. */
/** Agent tools the host may run: the registry (M37), each with verified policies (ADR 0027, 0032). */
export const HOST_PROVIDERS = AGENT_TOOLS.map((t) => t.id);

export class DeviceError extends Error {}

/* ------------------------------------------------------------------ pairing */

/** Four letters, a dash, four more — no 0/O or 1/I to misread off a screen. */
function userCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** The host asks to pair: a code for a person to confirm, and one for the host to poll with. */
export async function startPairing(db: Database, deviceName: string) {
  const name = deviceName.trim().slice(0, 80) || 'My computer';
  const deviceCode = generateToken();
  const code = userCode();
  const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
  await db.insert(devicePairings).values({ deviceCodeHash: hashToken(deviceCode), userCode: code, deviceName: name, expiresAt });
  return { deviceCode, userCode: code, expiresAt: expiresAt.toISOString() };
}

/** What the /pair page shows before you confirm: the device's name, if the code is live. */
export async function describePairing(db: Database, code: string) {
  const [p] = await db
    .select({ deviceName: devicePairings.deviceName, confirmed: devicePairings.confirmedByUserId })
    .from(devicePairings)
    .where(and(eq(devicePairings.userCode, code.trim().toUpperCase()), gt(devicePairings.expiresAt, new Date())))
    .limit(1);
  return p && !p.confirmed ? { deviceName: p.deviceName } : null;
}

/** A signed-in person confirms the code shown by their host. */
export async function confirmPairing(db: Database, userId: string, code: string): Promise<{ deviceName: string }> {
  const done = await db
    .update(devicePairings)
    .set({ confirmedByUserId: userId })
    .where(
      and(
        eq(devicePairings.userCode, code.trim().toUpperCase()),
        gt(devicePairings.expiresAt, new Date()),
        isNull(devicePairings.confirmedByUserId),
      ),
    )
    .returning({ deviceName: devicePairings.deviceName });
  if (!done.length) throw new DeviceError('that code is wrong or has expired — start again from the app');
  return done[0]!;
}

/**
 * The host polls with its device code. Once confirmed, the pairing becomes a
 * device and the host gets its token — exactly once.
 */
export async function pollPairing(
  db: Database,
  deviceCode: string,
): Promise<{ status: 'pending' } | { status: 'expired' } | { status: 'paired'; token: string; deviceId: string; name: string }> {
  return db.transaction(async (tx) => {
    const [p] = await tx
      .select()
      .from(devicePairings)
      .where(eq(devicePairings.deviceCodeHash, hashToken(deviceCode)))
      .for('update')
      .limit(1);
    if (!p || p.expiresAt.getTime() <= Date.now()) return { status: 'expired' as const };
    if (!p.confirmedByUserId) return { status: 'pending' as const };
    const token = generateToken();
    const [d] = await tx
      .insert(devices)
      .values({ userId: p.confirmedByUserId, name: p.deviceName, tokenHash: hashToken(token) })
      .returning({ id: devices.id, name: devices.name });
    await tx.delete(devicePairings).where(eq(devicePairings.deviceCodeHash, p.deviceCodeHash));
    return { status: 'paired' as const, token, deviceId: d!.id, name: d!.name };
  });
}

/* ------------------------------------------------------------------ devices */

export async function resolveDevice(db: Database, token: string | undefined) {
  if (!token) return null;
  const [d] = await db
    .select({ id: devices.id, userId: devices.userId, name: devices.name })
    .from(devices)
    .where(and(eq(devices.tokenHash, hashToken(token)), isNull(devices.revokedAt)))
    .limit(1);
  return d ?? null;
}

export async function listDevices(db: Database, userId: string, online: (id: string) => boolean): Promise<DeviceSummary[]> {
  const rows = await db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
    .orderBy(devices.createdAt);
  const out: DeviceSummary[] = [];
  for (const d of rows) {
    const grants = await db
      .select({ id: deviceGrants.grantId, label: deviceGrants.label, providers: deviceGrants.providers, org: deviceGrants.teamId })
      .from(deviceGrants)
      .where(eq(deviceGrants.deviceId, d.id))
      .orderBy(deviceGrants.label);
    out.push({
      id: d.id,
      name: d.name,
      online: online(d.id),
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      grants: grants.map((g) => ({ ...g, usable: g.providers.some((p) => HOST_PROVIDERS.includes(p)) })),
    });
  }
  return out;
}

/** Revoke a device: its token stops working, and so do the tokens of its bindings. */
export async function revokeDevice(db: Database, userId: string, deviceId: string): Promise<boolean> {
  const done = await db
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId), isNull(devices.revokedAt)))
    .returning({ id: devices.id });
  if (!done.length) return false;
  const bound = await db.select({ tokenId: sessionAgentHosts.tokenId }).from(sessionAgentHosts).where(eq(sessionAgentHosts.deviceId, deviceId));
  for (const b of bound) {
    if (b.tokenId) await db.update(sessionTokens).set({ revokedAt: new Date() }).where(eq(sessionTokens.id, b.tokenId));
  }
  return true;
}

/** ADR 0043: the organizations a person is in, for the host's "For" picker. */
export async function organizationsOf(db: Database, userId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: teams.id, name: teams.name })
    .from(teamMembers)
    .innerJoin(teams, eq(teams.id, teamMembers.teamId))
    .where(eq(teamMembers.userId, userId))
    .orderBy(teams.name);
}

/**
 * What the host reports. Labels and ids only; the paths stay on the machine.
 * ADR 0043: a grant scoped to an organization its owner isn't in is ignored,
 * as if it weren't sent (they left it, or the machine is wrong).
 */
export async function setGrants(
  db: Database,
  deviceId: string,
  grants: { id: string; label: string; providers: string[]; org?: string | null }[],
): Promise<void> {
  const [owner] = await db.select({ userId: devices.userId }).from(devices).where(eq(devices.id, deviceId)).limit(1);
  const mine = new Set(owner ? (await organizationsOf(db, owner.userId)).map((o) => o.id) : []);
  const seen = new Set<string>();
  const clean = grants
    .filter((g) => typeof g.id === 'string' && g.id.length > 0 && g.id.length <= 64)
    .filter((g) => g.org == null || (typeof g.org === 'string' && mine.has(g.org)))
    // One row per grant id, even if a frame repeats one: the key is (device, grant).
    .filter((g) => !seen.has(g.id) && Boolean(seen.add(g.id)))
    .slice(0, 100)
    .map((g) => ({
      deviceId,
      grantId: g.id,
      label: String(g.label ?? '').slice(0, 80) || 'folder',
      providers: (Array.isArray(g.providers) ? g.providers : []).map(String).slice(0, 10),
      teamId: g.org ?? null,
    }));
  await db.transaction(async (tx) => {
    // Two frames from one host arrive back to back (a grant, then a policy
    // change). Lock the device's row first, so their replace-all-grants
    // transactions run one after the other instead of colliding on the key.
    await tx.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId)).for('update');
    await tx.delete(deviceGrants).where(eq(deviceGrants.deviceId, deviceId));
    if (clean.length) await tx.insert(deviceGrants).values(clean);
  });
  await db.update(devices).set({ lastSeenAt: new Date() }).where(eq(devices.id, deviceId));
}

/* ----------------------------------------------------------------- bindings */

/**
 * "Add my agent": create the agent in the session and bind it to one of your
 * devices' grants. The provider must be installed there and have verified
 * policies (ADR 0027) — a Codex agent can't be bound until Codex is verified.
 */
export async function bindAgent(
  db: Database,
  opts: {
    sessionId: string;
    sessionPublicId: string;
    ownerSlug: string;
    publicUrl: string;
    user: { id: string; displayName: string };
    deviceId: string;
    grantId: string;
    provider?: string;
    displayName?: string;
    /** ADR 0043: the room's organization; null for a room in none. */
    sessionTeamId: string | null;
  },
) {
  const [device] = await db
    .select({ id: devices.id })
    .from(devices)
    .where(and(eq(devices.id, opts.deviceId), eq(devices.userId, opts.user.id), isNull(devices.revokedAt)))
    .limit(1);
  // Someone else's device is indistinguishable from no device.
  if (!device) throw new DeviceError('no such device');
  const [grant] = await db
    .select()
    .from(deviceGrants)
    .where(and(eq(deviceGrants.deviceId, opts.deviceId), eq(deviceGrants.grantId, opts.grantId)))
    .limit(1);
  if (!grant) throw new DeviceError('that folder is not granted on this device');
  // ADR 0043: a folder is for one organization's rooms, or Personal rooms.
  if ((grant.teamId ?? null) !== opts.sessionTeamId) {
    const [t] = grant.teamId ? await db.select({ name: teams.name }).from(teams).where(eq(teams.id, grant.teamId)).limit(1) : [];
    throw new DeviceError(`this folder is for ${t ? t.name : 'Personal rooms'}, not this room`);
  }
  const provider = opts.provider ?? grant.providers.find((p) => HOST_PROVIDERS.includes(p));
  if (!provider || !grant.providers.includes(provider)) throw new DeviceError('no supported agent tool is installed on that device');
  if (!HOST_PROVIDERS.includes(provider)) {
    throw new DeviceError(`${provider} can't run from the host: its folder policies aren't verified`);
  }

  // claude-<you>, codex-<you>, …: the tool's short name.
  const prefix = provider === 'claude-code' ? 'claude' : provider;
  const base = (opts.displayName ?? `${prefix}-${opts.user.displayName}`).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 40);
  let created: Awaited<ReturnType<typeof addAgentToSession>> | null = null;
  for (let n = 1; n <= 20 && !created?.ok; n++) {
    created = await addAgentToSession(db, {
      sessionId: opts.sessionId,
      ownerUserId: opts.user.id,
      displayName: n === 1 ? base : `${base}-${n}`,
      provider,
      label: 'host',
      publicUrl: opts.publicUrl,
      ownerSlug: opts.ownerSlug,
      sessionPublicId: opts.sessionPublicId,
    });
    if (!created.ok && !created.error.includes('already taken')) break;
  }
  if (!created?.ok) throw new DeviceError(created?.error ?? 'could not add the agent');

  // The setup token addAgentToSession issued was never shown to anyone: revoke
  // it. The host gets its own, minted when it next connects.
  await db
    .update(sessionTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessionTokens.participantId, created.created.agent.participantId), isNull(sessionTokens.revokedAt)));
  await db.insert(sessionAgentHosts).values({ sessionAgentId: created.created.agent.sessionAgentId, deviceId: opts.deviceId, grantId: opts.grantId });
  return created.created.agent;
}

/**
 * The bindings to send a host as it connects, each with a fresh token. The
 * previous token of each binding is revoked: a token lives one connection.
 */
export async function bindingsForDevice(db: Database, deviceId: string, publicUrl: string, only?: string) {
  const rows = await db
    .select({
      sessionAgentId: sessionAgentHosts.sessionAgentId,
      grantId: sessionAgentHosts.grantId,
      tokenId: sessionAgentHosts.tokenId,
      provider: agents.provider,
      ownerId: agents.ownerId,
      participantId: participants.id,
      displayName: participants.displayName,
      sessionId: sessions.id,
      publicId: sessions.publicId,
      title: sessions.title,
      ownerSlug: users.ownerSlug,
      roomOrg: sessions.teamId,
      fromPersonal: sessionAgentHosts.fromPersonal,
      grantOrg: deviceGrants.teamId,
      granted: deviceGrants.grantId,
    })
    .from(sessionAgentHosts)
    .innerJoin(sessionAgents, eq(sessionAgents.id, sessionAgentHosts.sessionAgentId))
    .innerJoin(agents, eq(agents.id, sessionAgents.agentId))
    .innerJoin(participants, eq(participants.sessionAgentId, sessionAgents.id))
    .innerJoin(sessions, eq(sessions.id, sessionAgents.sessionId))
    .innerJoin(users, eq(users.id, sessions.ownerId))
    .leftJoin(deviceGrants, and(eq(deviceGrants.deviceId, sessionAgentHosts.deviceId), eq(deviceGrants.grantId, sessionAgentHosts.grantId)))
    .where(
      only
        ? and(eq(sessionAgentHosts.deviceId, deviceId), eq(sessionAgentHosts.sessionAgentId, only))
        : eq(sessionAgentHosts.deviceId, deviceId),
    );

  const out = [];
  for (const r of rows) {
    // ADR 0043: only a folder in the room's scope (or an old Personal binding,
    // marked). A folder of an organization they've left isn't reported, so isn't here.
    const grantOrg = r.granted ? (r.grantOrg ?? null) : undefined;
    if (grantOrg === undefined) continue;
    if (grantOrg !== (r.roomOrg ?? null) && !(grantOrg === null && r.fromPersonal)) continue;
    if (r.tokenId) await db.update(sessionTokens).set({ revokedAt: new Date() }).where(eq(sessionTokens.id, r.tokenId));
    const token = generateToken();
    const [t] = await db
      .insert(sessionTokens)
      .values({ sessionId: r.sessionId, participantId: r.participantId, tokenHash: hashToken(token), label: 'host connection', createdByUserId: r.ownerId })
      .returning({ id: sessionTokens.id });
    await db.update(sessionAgentHosts).set({ tokenId: t!.id }).where(eq(sessionAgentHosts.sessionAgentId, r.sessionAgentId));
    const path = `/o/${r.ownerSlug}/s/${r.publicId}`;
    out.push({
      id: r.sessionAgentId,
      grantId: r.grantId,
      provider: r.provider,
      agent: { displayName: r.displayName },
      session: { title: r.title, ownerSlug: r.ownerSlug, publicId: r.publicId, org: r.roomOrg ?? null },
      ...(r.fromPersonal && grantOrg === null && r.roomOrg ? { fromPersonal: true } : {}),
      mcpUrl: `${publicUrl}/mcp${path}`,
      bridgeUrl: `${publicUrl.replace(/^http/, 'ws')}/bridge${path}`,
      token,
    });
  }
  return out;
}

/** The device a session agent is bound to, if any — for the Agents panel. */
export async function hostOf(db: Database, sessionAgentId: string) {
  const [r] = await db
    .select({
      deviceId: devices.id,
      deviceName: devices.name,
      grantId: sessionAgentHosts.grantId,
      label: deviceGrants.label,
      fromPersonal: sessionAgentHosts.fromPersonal,
    })
    .from(sessionAgentHosts)
    .innerJoin(devices, eq(devices.id, sessionAgentHosts.deviceId))
    .leftJoin(deviceGrants, and(eq(deviceGrants.deviceId, devices.id), eq(deviceGrants.grantId, sessionAgentHosts.grantId)))
    .where(eq(sessionAgentHosts.sessionAgentId, sessionAgentId))
    .limit(1);
  return r ?? null;
}

/* --------------------------------------------------------------------- hub */

/** Connected hosts, in-process like the event bus. */
const hosts = new Map<string, { send: (data: string) => void; close: () => void }>();
const rebinds = new Set<string>();

/** ADR 0043: tell every connected computer of this person about their organizations. */
export async function refreshHostsOf(db: Database, userId: string, rebind = false): Promise<void> {
  const mine = await db.select({ id: devices.id }).from(devices).where(and(eq(devices.userId, userId), isNull(devices.revokedAt)));
  if (!mine.some((d) => hostHub.online(d.id))) return;
  const organizations = await organizationsOf(db, userId);
  for (const d of mine) hostHub.refresh(d.id, organizations, rebind);
}

/** ADR 0043: a room changed organization: its hosts get their bindings anew (and check them). */
export async function refreshHostsInRoom(db: Database, sessionId: string): Promise<void> {
  const bound = await db
    .selectDistinct({ deviceId: sessionAgentHosts.deviceId, userId: devices.userId })
    .from(sessionAgentHosts)
    .innerJoin(sessionAgents, eq(sessionAgents.id, sessionAgentHosts.sessionAgentId))
    .innerJoin(devices, eq(devices.id, sessionAgentHosts.deviceId))
    .where(eq(sessionAgents.sessionId, sessionId));
  for (const b of bound) hostHub.refresh(b.deviceId, await organizationsOf(db, b.userId), true);
}

export const hostHub = {
  attach(deviceId: string, ws: { send: (data: string) => void; close: () => void }) {
    hosts.get(deviceId)?.close();
    hosts.set(deviceId, ws);
  },
  detach(deviceId: string, ws: unknown) {
    if (hosts.get(deviceId) === ws) hosts.delete(deviceId);
  },
  online: (deviceId: string) => hosts.has(deviceId),
  send(deviceId: string, frame: unknown) {
    hosts.get(deviceId)?.send(JSON.stringify(frame));
  },
  /**
   * ADR 0043: organizations changed for this device's owner, or a room it serves
   * moved. Send the list; the host reports its grants again, and (with `rebind`)
   * gets its bindings anew once the server has them.
   */
  refresh(deviceId: string, organizations: { id: string; name: string }[], rebind = false) {
    if (!hosts.has(deviceId)) return;
    if (rebind) rebinds.add(deviceId);
    hostHub.send(deviceId, { type: 'organizations', organizations });
  },
  /** True once after `refresh(…, true)`. */
  takeRebind: (deviceId: string) => rebinds.delete(deviceId),
  kick(deviceId: string) {
    const ws = hosts.get(deviceId);
    if (!ws) return;
    ws.send(JSON.stringify({ type: 'revoked' }));
    ws.close();
    hosts.delete(deviceId);
  },
};
