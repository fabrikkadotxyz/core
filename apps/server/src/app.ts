/**
 * Fabrikka server — M1.
 *
 * Routes are owner-scoped to mirror the MCP endpoint path exactly, so the web
 * API and the agent-facing contract cannot drift apart. See docs/protocol.md.
 *
 * Access rule, applied uniformly: anything a user may not see is a **404**,
 * never a 403. A 403 distinguishes "exists but not yours" from "doesn't exist",
 * which leaks private session ids. See docs/security.md.
 */
import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { relative, resolve as resolvePath } from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { createNodeWebSocket } from '@hono/node-ws';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { etag } from 'hono/etag';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { withPublicUrl } from './web-head.ts';
import { createClient, isEncryptionConfigured, runMigrations, type Database } from '@fabrikka/db';
import type {
  LoginBody,
  NotifySetting,
  PostMessageBody,
  RenameParticipantBody,
  SetupLane,
  SessionView,
  SignupBody,
  DeletionRequestBody,
} from '@fabrikka/types';
import {
  type AuthEnv,
  clearCookie,
  issueCookie,
  login,
  logout,
  pruneExpiredSessions,
  readCookie,
  requireUser,
  resolveToken,
} from './auth.ts';
import { publish, subscribe } from './bus.ts';
import { createSetup, SetupError } from './setup.ts';
import { allowedHostsFor, createMcpApp } from './mcp.ts';
import { cleanWanted, dismissGettingStarted, gettingStarted, markWelcomed, setPreferredAgents, validAgentChoices } from './onboarding.ts';
import { broadcastAbort, onAbort, pauseState, setPaused } from './rails.ts';
import { catchUp, endRun, recordActivity, startRun } from './activity.ts';
import {
  attachServer,
  listConnections,
  roomScopeOf,
  usableConnections,
  removeConnection,
  saveConnection,
  detachServer,
  discoverTools,
  listGrants,
  listTeamConnections,
  removeTeamConnection,
  saveTeamConnection,
  serversForUser,
  setGrant,
  slugsInSession,
  teamConnectionUses,
  teamServersFor,
  CALL_RECORD_DAYS,
  callRecordDays,
  pruneTeamCalls,
  setCallRecordDays,
  usableServers,
  replaceGrants,
  listGrantDefaults,
  saveGrantDefault,
  removeGrantDefault,
  applyGrantDefault,
  hasGrants,
} from './aggregation.ts';
import {
  createFileArtifact,
  createLinkArtifact,
  deleteArtifact,
  listArtifacts,
  readArtifact,
} from './artifacts.ts';
import {
  connectionStatuses,
  deliverMentions,
  listenForMentions,
  setConnectionStatus,
  blockedOn,
} from './delivery.ts';
import {
  addAgentToSession,
  issueRunToken,
  issueToken,
  resolveSessionToken,
  revokeOwnToken,
  listSessionAgents,
  listSessionTokens,
  revokeToken,
  setActivityVisible,
  setAgentTrustTier,
} from './agents.ts';
import {
  createInvite,
  describeInvite,
  listInvites,
  redeemInvite,
  revokeInvite,
} from './invites.ts';
import {
  addFile,
  attachSocket,
  createOutput,
  deleteOutput,
  isOutputId,
  listEdits,
  listOutputs,
  mountKindRoutes,
  OutputError,
  outputCreator,
  outputKinds,
  removeFile,
  renameOutput,
} from './outputs/core.ts';
import { createUser, getUserTheme, setUserTheme } from './users.ts';
import { GRACE_DAYS, requestDeletion, runDueDeletions } from './leaving.ts';
import { loginThrottle } from './login-throttle.ts';
import { AUDIT_DAYS, audit, auditCsv, auditForTeam, auditForUser, getAuditDays, pruneAudit, setAuditDays, userIdFor, type AuditInput } from './audit.ts';
import { BACKUP_KEEP_DAYS, createBackup, pruneBackups } from './backup.ts';
import { STORAGE_DIR } from './artifacts.ts';
import { exportAccount } from './account-export.ts';
import { getRetention, pruneRetention, RETENTION_DAYS, setRetention, summarize as summarizeRetention } from './retention.ts';
import { completeVerification, requestVerification, verificationRequired } from './verification.ts';
import { users, verifyPassword } from '@fabrikka/db';
import { eq } from 'drizzle-orm';
import { addStream, refreshRoom, startAttention } from './attention.ts';
import { DEFAULT_THEME, SYSTEM_THEMES, loadThemes, publicTheme, themeDirs, themeFile } from './themes.ts';
import {
  addFromRoster,
  createTeam,
  getTeam,
  listTeamsForUser,
  membershipOrigins,
  removeTeamMember,
  roster,
  sessionTeam,
  TeamError,
  teamRole,
  ownOrganizationOf,
} from './teams.ts';
import { cachedRepos, LinkError, linkedRepos, listLinks, removeLink, saveLink } from './links.ts';
import { addComment, listComments, reply, setResolved, threadAuthor } from './outputs/comments.ts';
import { getCatchUp, markSeen, waitingFor } from './catchup.ts';
import { exportSession } from './export.ts';
import {
  bindAgent,
  bindingsForDevice,
  confirmPairing,
  describePairing,
  DeviceError,
  hostHub,
  hostOf,
  listDevices,
  organizationsOf,
  pollPairing,
  refreshHostsOf,
  resolveDevice,
  revokeDevice,
  setGrants,
  startPairing,
} from './devices.ts';
import { ChatError, createChat, directCandidates, ensureGeneral, listTeamChats, openDirect } from './chats.ts';
import { applyTemplate, deleteTemplate, findTemplate, listTemplates, saveTemplate, sessionTemplate, TemplateError } from './templates/templates.ts';
import {
  countOwners,
  createMessage,
  createSession,
  deleteSession,
  listMembers,
  listMessages,
  listParticipants,
  getSessionContext,
  listSessionsForUser,
  setNotify,
  removeMember,
  renameParticipant,
  renameSession,
  resolveSessionForUser,
  resolveSessionForViewer,
  getVisibility,
  setVisibility,
  listGuests,
  removeGuest,
  setSessionStatus,
  updateSessionContext,
  type ContextUpdate,
} from './sessions.ts';

import { createKit, type Advertised, type Extension } from './kit.ts';
import { findEntry, isPreview, offeredEntries, setExtraEntries, unconfiguredEntries } from './connections/catalogue/registry.ts';
import { safeLogo } from './connections/catalogue/types.ts';
import { CATEGORY_NAMES, type CatalogueEntry } from './connections/catalogue/types.ts';
import { accountEmail, confirmPage, donePage, failedPage } from './connections/handoff.ts';
import {
  callbackPath,
  completeFlow,
  HANDOFF_COOKIE_MAX_AGE_S,
  handoffCookie,
  handoffPath,
  issueHandoff,
  OAuthError,
  readHandoff,
  startFlow,
} from './connections/oauth.ts';
import { mailerFromEnv } from './mail.ts';
import { appFor, appReleases, appStream, clientRelease, installCommand, installCommandWindows, installScript, installScriptWindows, manifest } from './client.ts';
import { homeFor } from './home.ts';
import { runBelongsTo, storeResumeArgv, validResumeArgv } from './activity.ts';
import { completePasswordReset, requestPasswordReset } from './password-reset.ts';
import { rateLimit } from './rate-limit.ts';
import { clientIp, clientIpHeader, trustedProxies } from './client-ip.ts';
import { checkWrite, membersChanged, noticeFor, roomScope, roomScopeByPublicId, writesGuarded } from './gates.ts';

export interface CreateAppOptions {
  /** Deployment-specific additions: a sign-up page, for one. */
  extensions?: Extension[];
  /** M18: catalogue entries beyond the built-in ones (a deployment's own vendors; the tests' fake one). */
  catalogue?: CatalogueEntry[];
}

/**
 * Build the whole server — API, MCP endpoint, sockets, web app — unstarted
 * (M32, ADR 0029). The core's own entry point is `createApp().start()`; a
 * deployment adds its extensions first. One app per process: the socket hubs
 * and the event bus are process-wide.
 */
export function createApp(options: CreateAppOptions = {}) {
  const PORT = Number(process.env.PORT ?? 9090);
  const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

  /**
   * M60 (ADR 0058): one event per privileged action. The signed-in user is the
   * actor unless the event says otherwise; the client address comes along.
   * Fire-and-forget: the trail never delays or fails the response.
   */
  const trail = (c: Context<AuthEnv>, e: Omit<AuditInput, 'ip'>) => {
    const me = (c.get('user') as { id: string } | undefined)?.id ?? null;
    void audit(db, { ...e, actorUserId: e.actorUserId === undefined ? me : e.actorUserId, ip: clientIp(c) });
  };
  const SECURE_COOKIES = PUBLIC_URL.startsWith('https://');

  /**
   * How to invoke the bridge, for the generated .mcp.json.
   *
   * Defaults to `fabrikka`, the client this instance serves at /install.sh
   * (M33, ADR 0030). Point it at the local build when developing the bridge:
   * BRIDGE_COMMAND="node /path/to/packages/bridge/dist/cli.js"
   */
  const BRIDGE_COMMAND = (process.env.BRIDGE_COMMAND ?? 'fabrikka')
    .split(' ')
    .filter(Boolean);

  const { db } = createClient();

  const app = new Hono<AuthEnv>();
  const { injectWebSocket, upgradeWebSocket: rawUpgradeWebSocket } = createNodeWebSocket({ app });

  /**
   * Every socket handler, guarded. They're async and nothing awaits them: one
   * that throws would be an unhandled rejection, which ends the process — so a
   * single bad frame from any paired host or bridge could take the server down
   * (found by M34's acceptance check). A failure is logged; the server stays up.
   */
  type SocketEvents = Parameters<Parameters<typeof rawUpgradeWebSocket>[1] extends infer E ? (c: Context, events: E) => void : never>[1];
  const upgradeWebSocket = (createEvents: (c: Context) => SocketEvents | Promise<SocketEvents>) =>
    rawUpgradeWebSocket((c: Context) => {
      // Synchronous when the setup is: handing the handlers back even a tick
      // late lets the socket's first frames go unheard (a host's first "grants").
      const created = createEvents(c);
      return created instanceof Promise ? created.then((e) => guard(c, e)) : guard(c, created);
    });

  function guard(c: Context, events: SocketEvents): SocketEvents {
    const wrapped: Record<string, unknown> = {};
    for (const [name, handler] of Object.entries(events)) {
      wrapped[name] =
        typeof handler === 'function'
          ? (...args: unknown[]) => {
              const fail = (err: unknown) => console.error(`[socket] ${c.req.path} ${name} failed:`, (err as Error)?.message ?? err);
              try {
                const result = (handler as (...a: unknown[]) => unknown)(...args);
                if (result instanceof Promise) return result.catch(fail);
                return result;
              } catch (err) {
                fail(err);
              }
            }
          : handler;
    }
    return wrapped as typeof events;
  }

  /**
   * The web dev server proxies /api to this origin, so browser requests are
   * same-origin in dev as well as production. CORS stays for direct-origin calls
   * during development and must allow credentials, since auth is cookie-based.
   */
  /*
   * ADR 0044: text goes out gzipped when the browser takes it. Never a
   * WebSocket's upgrade; server-sent events are excluded by type. /mcp and the
   * bridge's endpoints are left alone: agents, small messages.
   */
  const gzip = compress({ encoding: 'gzip' });
  const compressText: MiddlewareHandler = (c, next) => (c.req.header('upgrade') ? next() : gzip(c, next));
  /** A validator, so an unchanged file is a 304. Weak: the same file gzipped is the same file. */
  const validate = etag({ weak: true });
  app.use('/api/*', compressText);

  app.use(
    '/api/*',
    cors({ origin: ['http://localhost:5173'], credentials: true }),
  );

  app.get('/health', (c) => c.json({ ok: true }));

  /*
   * Extensions (M32, ADR 0029) mount here: before every core route that could
   * shadow theirs, and long before the web app's catch-all.
   */
  setExtraEntries(options.catalogue ?? []);
  const mailer = mailerFromEnv();
  const advertised: Advertised = { signupUrl: null };
  const kit = createKit({ db, publicUrl: PUBLIC_URL, secureCookies: SECURE_COOKIES, mailer, advertised });
  for (const ext of options.extensions ?? []) ext.mount(app, kit);

  /*
   * The client this instance serves, and its installer (M33, ADR 0030). Public:
   * a computer needs them before it's connected. 404 when there's no client build.
   */
  app.get('/install.sh', async (c) => {
    if (!(await clientRelease())) return c.notFound();
    c.header('content-type', 'text/x-shellscript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(installScript(PUBLIC_URL));
  });
  /** M57 (ADR 0056): Windows's installer, with this instance's address written in. */
  app.get('/install.ps1', async (c) => {
    if (!(await clientRelease())) return c.notFound();
    c.header('content-type', 'text/plain; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(installScriptWindows(PUBLIC_URL));
  });
  app.get('/downloads/manifest.json', async (c) => {
    const release = await clientRelease();
    if (!release) return c.notFound();
    c.header('cache-control', 'no-store');
    return c.json(manifest(release, PUBLIC_URL, await appReleases()));
  });
  app.get('/downloads/fabrikka.mjs', async (c) => {
    const release = await clientRelease();
    if (!release) return c.notFound();
    c.header('content-type', 'text/javascript; charset=utf-8');
    c.header('cache-control', 'no-store');
    return c.body(new Uint8Array(release.bytes));
  });
  // M34, M57: the desktop apps, one per platform, and their checksums, for the installers.
  app.get('/downloads/:file{.+\\.sha256}', async (c) => {
    const file = c.req.param('file').slice(0, -'.sha256'.length);
    const found = (await appReleases()).find((a) => a.file === file);
    if (!found) return c.notFound();
    c.header('cache-control', 'no-store');
    return c.text(`${found.sha256}  ${found.file}\n`);
  });
  app.get('/downloads/:file', async (c) => {
    const file = c.req.param('file');
    const found = (await appReleases()).find((a) => a.file === file);
    if (!found) return c.notFound();
    c.header('content-type', 'application/octet-stream');
    c.header('content-length', String(found.size));
    c.header('content-disposition', `attachment; filename="${found.file}"`);
    c.header('cache-control', 'no-store');
    return c.body(appStream(found));
  });
  /** For "Your devices": the command to copy, or null when this instance has no client to serve. */
  app.get('/api/client', async (c) => {
    const release = await clientRelease();
    // M55, M57: the desktop app's download for this browser's platform, when this instance serves one; and every platform it has.
    const apps = await appReleases();
    const mine = appFor(apps, c.req.header('user-agent'));
    const appUrl = mine ? `${PUBLIC_URL}/downloads/${mine.file}` : null;
    const platforms = apps.map((a) => a.platform);
    return c.json(
      release
        ? { installCommand: installCommand(PUBLIC_URL), installCommandWindows: installCommandWindows(PUBLIC_URL), version: release.version, appUrl, platforms }
        : { installCommand: null, installCommandWindows: null, version: null, appUrl, platforms },
    );
  });


  /* -------------------------------------------------------------------------- */
  /* Auth                                                                       */
  /* -------------------------------------------------------------------------- */

  /* ---- the first owner, in the browser (M39, ADR 0035) ---- */

  const setup = createSetup(db);

  /** Public: whether this instance still needs its owner. Says nothing else. */
  app.get('/api/setup', async (c) => c.json({ needed: await setup.needed() }));

  app.post('/api/setup', async (c) => {
    const body = await c.req
      .json<{ code?: string; email?: string; displayName?: string; password?: string }>()
      .catch(() => ({}) as Record<string, string | undefined>);
    try {
      const { email } = await setup.createOwner({
        code: String(body.code ?? ''),
        email: String(body.email ?? ''),
        displayName: String(body.displayName ?? ''),
        password: String(body.password ?? ''),
      });
      const signedIn = await login(db, email, String(body.password ?? ''));
      if (!signedIn) return c.json({ error: 'the owner was created, but signing in failed; sign in normally' }, 500);
      issueCookie(c, signedIn.token, SECURE_COOKIES);
      return c.json({ user: await resolveToken(db, signedIn.token) }, 201);
    } catch (err) {
      if (err instanceof SetupError) return err.status === 404 ? c.notFound() : c.json({ error: err.message }, err.status);
      throw err;
    }
  });

  app.post('/api/auth/login', async (c) => {
    const { email, password } = await c.req.json<LoginBody>();
    if (!email || !password) {
      return c.json({ error: 'email and password are required' }, 400);
    }

    // M59: a full window of failures refuses even the right password, with the
    // same answer, so a guesser learns neither the password nor the lock.
    const ip = clientIp(c);
    if (!loginThrottle.allowed(email, ip)) {
      console.warn(`[login] refused: too many failed sign-ins (${loginThrottle.failuresFor(email)} for the address) from ${ip}`);
      trail(c, { action: 'login.locked', actorUserId: null, subjectUserId: await userIdFor(db, email), outcome: 'refused' });
      return c.json({ error: 'invalid email or password' }, 401);
    }
    const signedIn = await login(db, email, password);
    // One message for "no such user", "wrong password" and (M58) a deactivated
    // or deleted account, so the endpoint is not an account enumeration oracle.
    if (!signedIn) {
      loginThrottle.failed(email, ip);
      trail(c, { action: 'login.failed', actorUserId: null, subjectUserId: await userIdFor(db, email), outcome: 'failed' });
      return c.json({ error: 'invalid email or password' }, 401);
    }

    issueCookie(c, signedIn.token, SECURE_COOKIES);
    void pruneExpiredSessions(db);

    const user = await resolveToken(db, signedIn.token);
    trail(c, { action: 'login.ok', actorUserId: user?.id ?? null });
    if (signedIn.reactivated) trail(c, { action: 'account.deletion_cancelled', actorUserId: user?.id ?? null, subjectUserId: user?.id ?? null });
    // M58 (ADR 0057): signing in during the grace period cancels the deletion.
    const notice = signedIn.reactivated
      ? 'You had asked for this account to be deleted. Signing in cancelled that: your account and everything in it are as you left them.'
      : undefined;
    return c.json(notice ? { user, notice } : { user });
  });

  /* ---- M62: Settings → Account → Download my data. Behind the password, like deletion. ---- */

  app.post('/api/me/export', requireUser(db), async (c) => {
    const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as { password?: unknown });
    if (typeof body.password !== 'string' || !body.password) return c.json({ error: 'your password is required' }, 400);
    const me = c.get('user');
    if (verificationRequired(mailer) && !me.emailVerified) return c.json({ error: 'confirm your email address first: the link is in your inbox, or ask for a new one in Settings → Account', verify: true }, 403);
    const out = await exportAccount(db, me.id, body.password);
    if (!out.ok) {
      if (out.status === 401) trail(c, { action: 'account.exported', subjectUserId: me.id, outcome: 'refused', detail: { reason: 'password' } });
      return c.json({ error: out.error }, out.status);
    }
    trail(c, { action: 'account.exported', subjectUserId: me.id, detail: { bytes: out.data.length } });
    return new Response(new Uint8Array(out.data), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${out.filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  });

  /* ---- M58 (ADR 0057): Settings → Account → Delete my account ---- */

  app.post('/api/me/deletion', requireUser(db), async (c) => {
    const body = await c.req.json<Partial<DeletionRequestBody>>().catch(() => ({}) as Partial<DeletionRequestBody>);
    if (typeof body.password !== 'string' || !body.password) return c.json({ error: 'your password is required' }, 400);
    const me = c.get('user');
    if (verificationRequired(mailer) && !me.emailVerified) return c.json({ error: 'confirm your email address first: the link is in your inbox, or ask for a new one in Settings → Account', verify: true }, 403);
    const result = await requestDeletion(db, me.id, { password: body.password, eraseName: body.eraseName === true });
    if (!result.ok) {
      if (result.status === 401) trail(c, { action: 'account.deletion_requested', subjectUserId: me.id, outcome: 'refused', detail: { reason: 'password' } });
      return c.json({ error: result.error }, result.status);
    }
    trail(c, { action: 'account.deletion_requested', subjectUserId: me.id, detail: { eraseName: body.eraseName === true, effectiveAt: result.effectiveAt.toISOString() } });
    // Signed out everywhere, this tab included.
    clearCookie(c, SECURE_COOKIES);
    const effective = result.effectiveAt.toISOString().slice(0, 10);
    if (mailer.configured) {
      void mailer
        .send({
          to: me.email,
          subject: 'Your Fabrikka account will be deleted',
          text:
            `You asked for your Fabrikka account (${me.email}) to be deleted. It is deactivated now and will be deleted on ${effective}.\n\n` +
            `Changed your mind? Sign in before then at ${PUBLIC_URL}/login and the deletion is cancelled.\n\n` +
            (body.eraseName
              ? 'What you wrote in rooms other people are in stays there, under the name "former-member".\n'
              : 'What you wrote in rooms other people are in stays there, under your name, marked as deactivated.\n'),
        })
        .catch((err) => console.warn(`[leaving] confirmation email failed: ${(err as Error).message}`));
    }
    return c.json({ ok: true, effectiveAt: result.effectiveAt.toISOString(), graceDays: GRACE_DAYS });
  });

  app.post('/api/auth/logout', async (c) => {
    const token = readCookie(c);
    const who = token ? await resolveToken(db, token) : null;
    if (token) await logout(db, token);
    clearCookie(c, SECURE_COOKIES);
    if (who) trail(c, { action: 'logout', actorUserId: who.id });
    return c.json({ ok: true });
  });

  app.get('/api/auth/me', async (c) => {
    const user = await resolveToken(db, readCookie(c));
    if (!user) return c.json({ error: 'not authenticated' }, 401);
    return c.json({ user });
  });

  /* ------------------------------------------------ themes (M44, ADR 0038) */

  // Checked once, at start: a pack added later is offered after a restart.
  const themes = loadThemes(themeDirs());

  /** Every theme this instance offers. Public, so the sign-in page is themed too. */
  app.get('/api/themes', (c) =>
    c.json({ themes: [...themes.values()].map(publicTheme), default: DEFAULT_THEME, system: SYSTEM_THEMES }),
  );

  /**
   * Only files the start-up check accepted, typed by extension. ADR 0044:
   * theme.css is checked on every load, so a change shows on the next reload;
   * fonts and images may be kept for a day (rename one to replace it).
   */
  app.get('/themes/:id/*', compressText, validate, async (c) => {
    const id = c.req.param('id');
    const path = decodeURIComponent(c.req.path.slice(`/themes/${id}/`.length));
    const file = themeFile(themes, id, path);
    if (!file) return c.notFound();
    const body = await readFile(file.abs);
    return c.body(body, 200, {
      'content-type': file.type,
      'x-content-type-options': 'nosniff',
      'cache-control': path.endsWith('.css') ? 'no-cache' : 'public, max-age=86400',
    });
  });

  app.get('/api/me/theme', requireUser(db), async (c) => {
    const saved = await getUserTheme(db, c.get('user').id);
    // A theme the instance no longer offers reads as the default, and stays saved.
    const theme = saved === 'system' || (saved && themes.has(saved)) ? saved : null;
    return c.json({ theme });
  });

  app.put('/api/me/theme', requireUser(db), async (c) => {
    const body = await c.req.json<{ theme?: unknown }>().catch(() => ({}) as { theme?: unknown });
    const theme = body.theme ?? null;
    if (theme !== null && theme !== 'system' && (typeof theme !== 'string' || !themes.has(theme))) {
      return c.json({ error: 'this instance offers no such theme' }, 400);
    }
    await setUserTheme(db, c.get('user').id, theme as string | null);
    return c.json({ theme });
  });

  /* ---- onboarding (M47): the welcome, then Get started; only about you ---- */

  app.get('/api/me/getting-started', requireUser(db), async (c) => c.json(await gettingStarted(db, c.get('user').id)));

  /** The welcome's Continue: the look it chose (as PUT /api/me/theme), and never again. */
  app.post('/api/me/welcome', requireUser(db), async (c) => {
    type Body = { theme?: unknown; agents?: unknown; wanted?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const theme = body.theme === undefined ? undefined : (body.theme ?? null);
    if (theme !== undefined && theme !== null && theme !== 'system' && (typeof theme !== 'string' || !themes.has(theme))) {
      return c.json({ error: 'this instance offers no such theme' }, 400);
    }
    // 2026-10-17: the agents they use, registry ids and/or 'other', and the ones they wish for; anything else is refused, nothing is marked.
    if (body.agents !== undefined && body.agents !== null && !validAgentChoices(body.agents)) return c.json({ error: 'no such agent tool' }, 400);
    const wanted = body.wanted === undefined ? undefined : cleanWanted(body.wanted);
    if (wanted === null) return c.json({ error: 'wanted agents: a short list of short names' }, 400);
    if (theme !== undefined) await setUserTheme(db, c.get('user').id, theme as string | null);
    if (body.agents !== undefined || wanted !== undefined) await setPreferredAgents(db, c.get('user').id, (body.agents as string[] | null | undefined) ?? null, wanted);
    await markWelcomed(db, c.get('user').id);
    return c.json({ ok: true });
  });

  /** The agents you use, and wish for, changed later from Your devices. A preference, never a restriction. */
  app.put('/api/me/agents', requireUser(db), async (c) => {
    type Body = { agents?: unknown; wanted?: unknown };
    const body = await c.req.json<Body>().catch(() => ({}) as Body);
    const agents = body.agents ?? null;
    if (agents !== null && !validAgentChoices(agents)) return c.json({ error: 'no such agent tool' }, 400);
    const wanted = body.wanted === undefined ? undefined : cleanWanted(body.wanted);
    if (wanted === null) return c.json({ error: 'wanted agents: a short list of short names' }, 400);
    await setPreferredAgents(db, c.get('user').id, agents as string[] | null, wanted);
    return c.json({ ok: true, agents: agents as string[] | null, wanted: wanted ?? undefined });
  });

  app.post('/api/me/getting-started/dismiss', requireUser(db), async (c) => {
    await dismissGettingStarted(db, c.get('user').id);
    return c.json({ ok: true });
  });

  /** What the login page should offer (M32): reset by email, and a sign-up page an extension advertised. */
  app.get('/api/auth/options', (c) =>
    // M64: `verifiesEmail` says whether this instance asks for a proven address.
    c.json({ passwordReset: mailer.configured, signupUrl: advertised.signupUrl, verifiesEmail: verificationRequired(mailer) }),
  );

  /* ---- M64: a verified address ---- */

  /** Use a link from an email. No sign-in needed: the link is the proof. */
  app.post('/api/auth/verify', async (c) => {
    const { token } = await c.req.json<{ token?: string }>().catch(() => ({}) as { token?: string });
    if (!token) return c.json({ error: 'a token is required' }, 400);
    if (!rateLimit(`verify:ip:${clientIp(c)}`, { max: 30, windowMs: 15 * 60_000 })) return c.json({ error: 'too many attempts; try again later' }, 429);
    const done = await completeVerification(db, token);
    if (!done.ok) return c.json({ error: done.error }, 400);
    trail(c, { action: done.changedFrom ? 'email.changed' : 'email.verified', actorUserId: done.userId, subjectUserId: done.userId });
    if (done.changedFrom && mailer.configured) {
      void mailer.send({ to: done.changedFrom, subject: 'Your Fabrikka address has changed', text: `Your Fabrikka account now uses a different email address. If this wasn't you, contact the person who runs this instance.\n` });
    }
    return c.json({ ok: true, email: done.email, changed: done.changedFrom !== null });
  });

  /** Send the link again, for the address on the account. */
  app.post('/api/me/verification', requireUser(db), async (c) => {
    const me = c.get('user');
    if (me.emailVerified) return c.json({ ok: true, alreadyVerified: true });
    if (!rateLimit(`verification:user:${me.id}`, { max: 5, windowMs: 60 * 60_000 })) return c.json({ error: 'a link was sent recently; check your inbox, and try again in an hour' }, 429);
    const sent = await requestVerification(db, mailer, { userId: me.id, publicUrl: PUBLIC_URL });
    if (!sent.ok) return c.json({ error: sent.error }, sent.status);
    trail(c, { action: 'email.verification_sent', subjectUserId: me.id });
    return c.json({ ok: true });
  });

  /** Move the account to a new address: the password again, a link to the new one, a notice to the old. */
  app.post('/api/me/email', requireUser(db), async (c) => {
    const body = await c.req.json<{ email?: unknown; password?: unknown }>().catch(() => ({}) as { email?: unknown; password?: unknown });
    if (typeof body.email !== 'string' || typeof body.password !== 'string' || !body.password) return c.json({ error: 'the new address and your password are required' }, 400);
    const me = c.get('user');
    if (verificationRequired(mailer) && !me.emailVerified) return c.json({ error: 'confirm your current address first', verify: true }, 403);
    const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, me.id)).limit(1);
    if (!row || !(await verifyPassword(body.password, row.passwordHash))) return c.json({ error: 'wrong password' }, 401);
    if (!rateLimit(`email-change:user:${me.id}`, { max: 5, windowMs: 60 * 60_000 })) return c.json({ error: 'too many attempts; try again in an hour' }, 429);
    const sent = await requestVerification(db, mailer, { userId: me.id, publicUrl: PUBLIC_URL, newEmail: body.email });
    if (!sent.ok) return c.json({ error: sent.error }, sent.status);
    trail(c, { action: 'email.change_requested', subjectUserId: me.id });
    return c.json({ ok: true, to: sent.to });
  });

  /**
   * Ask for a reset link (M32, ADR 0029). Only with an email transport; the
   * answer never says whether the address has an account. Rate-limited per
   * address and per IP. See docs/security.md.
   */
  app.post('/api/auth/password-reset', async (c) => {
    if (!mailer.configured) return c.notFound();
    const { email } = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
    if (!email?.includes('@')) return c.json({ error: 'an email address is required' }, 400);
    const ip = clientIp(c);
    const window = 15 * 60 * 1000;
    // Both counters move on every request, so neither can be dodged by varying the other.
    const underEmail = rateLimit(`reset:email:${email.trim().toLowerCase()}`, { max: 5, windowMs: window });
    const underIp = rateLimit(`reset:ip:${ip}`, { max: 20, windowMs: window });
    if (!underEmail || !underIp) return c.json({ error: 'too many requests — try again in a few minutes' }, 429);
    await requestPasswordReset(db, mailer, { email, publicUrl: PUBLIC_URL });
    trail(c, { action: 'password.reset_requested', actorUserId: null, subjectUserId: await userIdFor(db, email) });
    return c.json({ ok: true });
  });

  app.post('/api/auth/password-reset/confirm', async (c) => {
    if (!mailer.configured) return c.notFound();
    const { token, password } = await c.req.json<{ token?: string; password?: string }>().catch(() => ({}) as { token?: string; password?: string });
    if (!token || !password) return c.json({ error: 'token and password are required' }, 400);
    const done = await completePasswordReset(db, token, password);
    trail(c, { action: 'password.reset_completed', actorUserId: null, outcome: done.ok ? 'ok' : 'failed' });
    return done.ok ? c.json({ ok: true }) : c.json({ error: done.error }, 400);
  });

  /**
   * Signup ALWAYS requires an invite token: there is no open registration, so
   * signup and invite-acceptance are one code path rather than two (ADR 0007).
   */
  app.post('/api/auth/signup', async (c) => {
    // M59: an invite token is 128 random bits, so this is a brake on abuse, not the defence.
    if (!rateLimit(`signup:ip:${clientIp(c)}`, { max: 300, windowMs: 15 * 60_000 })) {
      return c.json({ error: 'too many sign-ups from this address; try again later' }, 429);
    }
    const body = await c.req.json<SignupBody>();
    if (!body.token) return c.json({ error: 'an invite token is required' }, 400);
    if (!body.email || !body.password || !body.displayName) {
      return c.json({ error: 'email, password and displayName are required' }, 400);
    }
    if (body.password.length < 8) {
      return c.json({ error: 'password must be at least 8 characters' }, 400);
    }

    // Validate the invite before creating anything, so a bad token leaves no user.
    const preview = await describeInvite(db, body.token);
    if (!preview) return c.json({ error: 'invite is invalid or expired' }, 400);
    if (
      preview.invitedEmail &&
      preview.invitedEmail !== body.email.trim().toLowerCase()
    ) {
      return c.json({ error: 'this invite is for a different email address' }, 403);
    }

    // In a transaction, so a deployment's account check and the insert are one step (ADR 0041).
    const created = await db.transaction((tx) =>
      createUser(tx as unknown as Database, {
        email: body.email,
        password: body.password,
        displayName: body.displayName,
      }),
    );
    if (!created.ok) return c.json({ error: created.error }, created.refused ? 403 : 409);

    const redeemed = await redeemInvite(db, body.token, created.user);
    if (!redeemed.ok) return c.json({ error: `invite ${redeemed.reason}` }, 400);
    if (redeemed.team) membersChanged(db, redeemed.team.id);
    // M60: a sign-up through a link is a redemption too; the new account is the actor.
    trail(c, {
      action: 'invite.redeemed',
      actorUserId: created.user.id,
      subjectUserId: created.user.id,
      teamId: redeemed.team?.id ?? null,
      detail: { sessionPublicId: redeemed.session?.publicId ?? null, team: redeemed.team?.name ?? null, signup: true },
    });

    const signedIn = await login(db, body.email, body.password);
    if (signedIn) issueCookie(c, signedIn.token, SECURE_COOKIES);
    // M64: where the instance can send email, a sign-up through a link proves its address by a second link.
    if (verificationRequired(mailer)) {
      void requestVerification(db, mailer, { userId: created.user.id, publicUrl: PUBLIC_URL })
        .then(async (r) => {
          if (r.ok) await audit(db, { action: 'email.verification_sent', actorKind: 'system', subjectUserId: created.user.id });
        })
        .catch((err) => console.warn(`[verify] could not send: ${(err as Error).message}`));
    }

    // A session invite lands you in the session; a team invite on the team (M21).
    return c.json({ user: created.user, session: redeemed.session, team: redeemed.team }, 201);
  });

  /* -------------------------------------------------------------------------- */
  /* Invite preview and redemption                                              */
  /* -------------------------------------------------------------------------- */

  /** Unauthenticated: lets the invite page say which session it is for. */
  app.get('/api/invites/:token', async (c) => {
    const preview = await describeInvite(db, c.req.param('token'));
    if (!preview) return c.notFound();
    return c.json(preview);
  });

  /** Redeem as an already-logged-in user. */
  app.post('/api/invites/:token/redeem', requireUser(db), async (c) => {
    // M59: the same brake, per account, on trying invite tokens.
    if (!rateLimit(`redeem:user:${c.get('user').id}`, { max: 300, windowMs: 15 * 60_000 })) {
      return c.json({ error: 'too many attempts; try again later' }, 429);
    }
    const result = await redeemInvite(db, c.req.param('token'), c.get('user'));
    if (!result.ok) return c.json({ error: result.reason }, 400);
    if (result.team) membersChanged(db, result.team.id);
    // ADR 0043: their computers learn the new organization, for the Folders window's "For".
    if (result.team) void refreshHostsOf(db, c.get('user').id).catch(() => {});
    trail(c, {
      action: 'invite.redeemed',
      subjectUserId: c.get('user').id,
      teamId: result.team?.id ?? null,
      detail: { sessionPublicId: result.session?.publicId ?? null, team: result.team?.name ?? null },
    });
    return c.json({ session: result.session, team: result.team });
  });

  /* -------------------------------------------------------------------------- */
  /* Sessions                                                                   */
  /* -------------------------------------------------------------------------- */

  app.get('/api/sessions', requireUser(db), async (c) =>
    c.json(await listSessionsForUser(db, c.get('user').id)),
  );

  /**
   * ADR 0041: a deployment's write check, answered 402 with its reason and link.
   * Null when the write may go ahead (always, when no check is registered).
   */
  async function gateWrite(
    c: Context<AuthEnv>,
    scope: { teamId: string | null; ownerUserId: string },
    action: string,
  ): Promise<Response | null> {
    if (!writesGuarded()) return null;
    const refusal = await checkWrite({ userId: c.get('user').id, ...scope, action });
    return refusal ? c.json({ error: refusal.reason, url: refusal.url ?? null, gated: true }, 402) : null;
  }

  app.post('/api/sessions', requireUser(db), async (c) => {
    const body = await c.req.json<{ title?: string; teamId?: string; templateRef?: string; visibility?: string }>();
    const { title, templateRef } = body;
    const trimmed = title?.trim();
    if (!trimmed) return c.json({ error: 'title is required' }, 400);
    // A team you aren't on is indistinguishable from one that doesn't exist.
    if (body.teamId && !(await teamRole(db, body.teamId, c.get('user').id))) return c.json({ error: 'no such organization' }, 404);
    // M53 (ADR 0051): every session is in an organization; unnamed, it is your own.
    const teamId = body.teamId ?? (await ownOrganizationOf(db, c.get('user').id))?.id ?? null;
    if (!teamId) return c.json({ error: 'a session belongs to an organization' }, 400);
    if (body.visibility !== undefined && body.visibility !== 'private' && body.visibility !== 'team') return c.json({ error: 'visibility is private or team' }, 400);
    const gated = await gateWrite(c, { teamId, ownerUserId: c.get('user').id }, 'room');
    if (gated) return gated;

    // M25: a template you can't use is indistinguishable from one that doesn't exist.
    const template = templateRef ? await findTemplate(db, c.get('user').id, templateRef) : null;
    if (templateRef && !template) return c.json({ error: 'no such template' }, 404);
    // M53: the + beside Organization sessions starts one the organization reads along from the start.
    const created = await createSession(db, c.get('user'), trimmed, { teamId, visibility: body.visibility === 'team' ? 'team' : 'private' });
    if (template) {
      const s = await resolveSessionForUser(db, created.ownerSlug, created.publicId, c.get('user').id);
      await applyTemplate(db, { sessionId: s!.id, participantId: s!.participantId, template });
    }
    return c.json(created, 201);
  });

  /* -------------------------------------------------------------------------- */
  /* Teams (M21). A list of people; nothing else. See ADR 0025.                  */
  /* Every route is a 404 to someone who isn't on the team.                      */
  /* -------------------------------------------------------------------------- */

  app.get('/api/teams', requireUser(db), async (c) => {
    const mine = await listTeamsForUser(db, c.get('user').id);
    // Teams from before M29 get their #general the first time anyone looks.
    for (const t of mine) await ensureGeneral(db, t.id);
    // ADR 0041: a deployment's notice on each team, when it gives one.
    const withNotices = await Promise.all(mine.map(async (t) => ({ ...t, notice: await noticeFor(t.id, c.get('user').id) })));
    return c.json(withNotices);
  });

  app.post('/api/teams', requireUser(db), async (c) => {
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    try {
      const team = await createTeam(db, c.get('user').id, name ?? '');
      membersChanged(db, team.id);
      void refreshHostsOf(db, c.get('user').id).catch(() => {});
      trail(c, { action: 'team.created', teamId: team.id, detail: { name: team.name } });
      return c.json(team, 201);
    } catch (err) {
      if (err instanceof TeamError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get('/api/teams/:id', requireUser(db), async (c) => {
    const team = await getTeam(db, c.req.param('id'), c.get('user').id);
    return team ? c.json(team) : c.notFound();
  });

  app.get('/api/teams/:id/invites', requireUser(db), async (c) => {
    if ((await teamRole(db, c.req.param('id'), c.get('user').id)) !== 'owner') return c.notFound();
    return c.json(await listInvites(db, { teamId: c.req.param('id') }));
  });

  /** Same links as a session invite: single-use, expiring, hashed (M1, ADR 0007). */
  app.post('/api/teams/:id/invites', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    if ((await teamRole(db, teamId, c.get('user').id)) !== 'owner') return c.notFound();
    const gated = await gateWrite(c, { teamId, ownerUserId: c.get('user').id }, 'invite');
    if (gated) return gated;
    const body = await c.req.json<{ invitedEmail?: string; role?: string }>().catch(() => ({}) as { invitedEmail?: string; role?: string });
    const { summary, token } = await createInvite(db, {
      teamId,
      createdByUserId: c.get('user').id,
      role: body.role === 'owner' ? 'owner' : 'member',
      invitedEmail: body.invitedEmail ?? null,
    });
    trail(c, { action: 'invite.created', teamId, detail: { inviteId: summary.id, role: summary.role } });
    return c.json({ invite: summary, token, url: `${PUBLIC_URL}/invite/${token}` }, 201);
  });

  app.post('/api/teams/:id/invites/:inviteId/revoke', requireUser(db), async (c) => {
    if ((await teamRole(db, c.req.param('id'), c.get('user').id)) !== 'owner') return c.notFound();
    const revoked = await revokeInvite(db, { teamId: c.req.param('id') }, c.req.param('inviteId'));
    if (revoked) trail(c, { action: 'invite.revoked', teamId: c.req.param('id'), detail: { inviteId: c.req.param('inviteId') } });
    return revoked ? c.json({ ok: true }) : c.notFound();
  });

  /** An owner removes a member; anyone may remove themselves (leave). */
  app.delete('/api/teams/:id/members/:userId', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const me = c.get('user').id;
    const role = await teamRole(db, teamId, me);
    const target = c.req.param('userId');
    if (!role || (role !== 'owner' && target !== me)) return c.notFound();
    if (!(await teamRole(db, teamId, target))) return c.notFound();
    try {
      await removeTeamMember(db, teamId, target);
    } catch (err) {
      if (err instanceof TeamError) return c.json({ error: err.message }, 409);
      throw err;
    }
    membersChanged(db, teamId);
    trail(c, { action: 'team.member_removed', teamId, subjectUserId: target, detail: { left: target === me } });
    // ADR 0043: their computers stop offering, and running, that organization's folders.
    void refreshHostsOf(db, target, true).catch(() => {});
    return c.json({ ok: true });
  });

  /** M24: mentions of you across your sessions, since you last opened each. */
  app.get('/api/waiting', requireUser(db), async (c) => c.json(await waitingFor(db, c.get('user').id)));
  /** M56: the home in one answer: what needs you, what is running, what changed. */
  app.get('/api/me/home', requireUser(db), async (c) => c.json(await homeFor(db, c.get('user').id, hostHub.online)));

  /* ---- templates (M25): a session's structure, never its content ---- */

  app.get('/api/templates', requireUser(db), async (c) => c.json(await listTemplates(db, c.get('user').id)));

  app.delete('/api/templates/:ref', requireUser(db), async (c) =>
    (await deleteTemplate(db, c.get('user').id, c.req.param('ref'))) ? c.json({ ok: true }) : c.notFound(),
  );

  /* ---- personal integrations (M28): your own connections, outside any session ---- */

  /**
   * ADR 0043: a connection is for one organization's rooms (`?team=<id>`, or
   * `teamId` in a body) or Personal (absent). An organization you're not in is
   * refused, except to remove a connection you made while you were.
   */
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const scopeOf = async (c: Context<AuthEnv>, raw: unknown, removing = false): Promise<{ ok: true; scope: string | null } | { ok: false }> => {
    if (raw === undefined || raw === null || raw === '') return { ok: true, scope: null };
    if (typeof raw !== 'string' || !UUID_RE.test(raw)) return { ok: false };
    if (!removing && !(await teamRole(db, raw, c.get('user').id))) return { ok: false };
    return { ok: true, scope: raw };
  };

  app.get('/api/me/connections', requireUser(db), async (c) => {
    const scope = await scopeOf(c, c.req.query('team'));
    if (!scope.ok) return c.json({ error: 'no such organization' }, 404);
    const all = await listConnections(db, c.get('user').id, 'all');
    const mine = new Set((await organizationsOf(db, c.get('user').id)).map((o) => o.id));
    // ADR 0043 (amended 2026-10-14): no `team` lists every connection you can
    // still use, each with its scope; `?team=` exactly that organization's.
    const asked = c.req.query('team');
    return c.json({
      connections: all.filter((x) => (asked === undefined ? x.teamId === null || mine.has(x.teamId) : x.teamId === scope.scope)),
      // For organizations you've left: they no longer work anywhere, listed to remove.
      orphaned: all.filter((x) => x.teamId !== null && !mine.has(x.teamId)),
      encryptionConfigured: isEncryptionConfigured(),
    });
  });

  app.post('/api/me/connections', requireUser(db), async (c) => {
    const body = await c.req.json<{ slug?: string; label?: string; url?: string; credential?: string; username?: string; teamId?: string | null }>();
    if (!body.slug || !body.url) return c.json({ error: 'slug and url are required' }, 400);
    const scope = await scopeOf(c, body.teamId);
    if (!scope.ok) return c.json({ error: 'no such organization' }, 404);
    trail(c, { action: 'connection.attached', teamId: body.teamId ?? null, detail: { slug: body.slug, shared: false } });
    const saved = await saveConnection(db, { userId: c.get('user').id, slug: body.slug, label: body.label, url: body.url, credential: body.credential, username: body.username, teamId: scope.scope });
    return saved.ok ? c.json(saved.server, 201) : c.json({ error: saved.error }, 400);
  });

  /** Removing a connection detaches it from every session it was in. */
  app.delete('/api/me/connections/:slug', requireUser(db), async (c) => {
    const scope = await scopeOf(c, c.req.query('team'), true);
    if (!scope.ok) return c.notFound();
    const removed = await removeConnection(db, c.get('user').id, c.req.param('slug'), scope.scope);
    if (removed) trail(c, { action: 'connection.removed', teamId: c.req.query('team') ?? null, detail: { slug: c.req.param('slug'), shared: false } });
    return removed ? c.json({ ok: true }) : c.notFound();
  });

  /* ---- M52 (ADR 0049): the grants you usually allow, per integration ---- */

  app.get('/api/me/grant-defaults', requireUser(db), async (c) => {
    return c.json({ defaults: await listGrantDefaults(db, c.get('user').id) });
  });

  /** One name today, `default`; the key carries the name so named sets come later. */
  app.put('/api/me/grant-defaults/:slug', requireUser(db), async (c) => {
    const body = await c.req.json<{ tools?: unknown; name?: string }>();
    if (!Array.isArray(body.tools) || !body.tools.every((t) => typeof t === 'string')) return c.json({ error: 'tools is a list of tool names' }, 400);
    const name = body.name ?? 'default';
    if (name !== 'default') return c.json({ error: 'only the default is named today' }, 400);
    await saveGrantDefault(db, c.get('user').id, c.req.param('slug'), name, [...new Set(body.tools as string[])]);
    return c.json({ ok: true, tools: new Set(body.tools as string[]).size });
  });

  app.delete('/api/me/grant-defaults/:slug', requireUser(db), async (c) => {
    return (await removeGrantDefault(db, c.get('user').id, c.req.param('slug'), c.req.query('name') ?? 'default')) ? c.json({ ok: true }) : c.notFound();
  });

  /* ---- connections by vendor (M18, ADR 0024) ---- */

  /** What can be connected here, by category, and whether you already have it. */
  app.get('/api/connections/catalogue', requireUser(db), async (c) => {
    // ADR 0043: "connected" means in the scope the page is showing.
    const scope = await scopeOf(c, c.req.query('team'));
    if (!scope.ok) return c.json({ error: 'no such organization' }, 404);
    const mine = await listConnections(db, c.get('user').id, scope.scope);
    return c.json({
      categories: CATEGORY_NAMES,
      entries: offeredEntries().map((e) => {
        const have = mine.find((m) => m.slug === e.slug);
        return {
          id: e.id,
          name: e.name,
          category: e.category,
          description: e.description,
          connectionName: e.connectionName ?? null,
          fields: (e.fields ?? []).map((f) => ({ key: f.key, label: f.label, placeholder: f.placeholder ?? '', required: f.required })),
          presets: e.presets ? { read: e.presets.read.length, write: e.presets.write.length } : null,
          keywords: e.keywords ?? [],
          logo: safeLogo(e.logo),
          preview: isPreview(e),
          connected: !!have,
          status: have?.status ?? null,
        };
      }),
      // Vendors this server can't offer yet, so the page can say why instead of hiding them.
      unavailable: unconfiguredEntries().map(({ entry, missing }) => ({
        id: entry.id,
        name: entry.name,
        category: entry.category,
        keywords: entry.keywords ?? [],
        logo: safeLogo(entry.logo),
        missing,
      })),
      encryptionConfigured: isEncryptionConfigured(),
    });
  });

  /**
   * Begin signing in to a vendor: the browser goes to the URL returned. The
   * desktop app asks for a `handoff` instead, a link it opens in the default
   * browser (ADR 0033).
   */
  app.post('/api/connections/oauth/start', requireUser(db), async (c) => {
    if (!isEncryptionConfigured()) return c.json({ error: 'FABRIKKA_ENCRYPTION_KEY is not set, so tokens could not be stored' }, 503);
    const body = await c.req
      .json<{ entry?: string; fields?: Record<string, string>; handoff?: boolean; teamId?: string | null }>()
      .catch(() => ({}) as { entry?: string; handoff?: boolean; teamId?: string | null });
    // ADR 0043: the scope travels with the flow, from here to the callback.
    const scope = await scopeOf(c, body.teamId);
    if (!scope.ok) return c.json({ error: 'no such organization' }, 404);
    try {
      if (body.handoff === true) {
        const handoffUrl = issueHandoff({ userId: c.get('user').id, entryId: String(body.entry ?? ''), fields: (body as { fields?: Record<string, string> }).fields, publicUrl: PUBLIC_URL, teamId: scope.scope });
        return c.json({ handoffUrl });
      }
      const authorizeUrl = await startFlow(db, { userId: c.get('user').id, entryId: String(body.entry ?? ''), fields: (body as { fields?: Record<string, string> }).fields, publicUrl: PUBLIC_URL, teamId: scope.scope });
      return c.json({ authorizeUrl });
    } catch (err) {
      if (err instanceof OAuthError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /**
   * The desktop app's handoff, in the default browser (ADR 0033). GET only names
   * the account; the person's Continue (POST) starts the flow and binds this
   * browser to it with a cookie holding its `state`.
   */
  app.get(handoffPath, async (c) => {
    const handoff = readHandoff(c.req.query('t'));
    if (!handoff) return c.html(failedPage('This link has expired or is not valid.'), 400);
    const email = await accountEmail(db, handoff.userId);
    const entry = findEntry(handoff.entryId);
    if (!email || !entry) return c.html(failedPage('This link has expired or is not valid.'), 400);
    return c.html(confirmPage({ vendor: entry.name, email, ticket: c.req.query('t') ?? '' }));
  });

  app.post(handoffPath, async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const handoff = readHandoff(typeof form.t === 'string' ? form.t : undefined);
    if (!handoff) return c.html(failedPage('This link has expired or is not valid.'), 400);
    try {
      const authorizeUrl = await startFlow(db, { ...handoff, publicUrl: PUBLIC_URL });
      const state = new URL(authorizeUrl).searchParams.get('state') ?? '';
      setCookie(c, handoffCookie, state, { httpOnly: true, sameSite: 'Lax', secure: SECURE_COOKIES, path: callbackPath, maxAge: HANDOFF_COOKIE_MAX_AGE_S });
      return c.redirect(authorizeUrl);
    } catch (err) {
      if (err instanceof OAuthError) return c.html(failedPage(err.message), 400);
      throw err;
    }
  });

  /**
   * The vendor sends the browser back here. Signed in: land on Personal
   * integrations either way. Through the handoff: the browser's cookie must hold
   * this exact `state`, and it ends on a page that sends the person back to the app.
   */
  app.get(callbackPath, async (c) => {
    const { code, state, error, error_description } = c.req.query();
    const bound = getCookie(c, handoffCookie);
    if (bound !== undefined) deleteCookie(c, handoffCookie, { path: callbackPath, secure: SECURE_COOKIES });
    const viaHandoff = !!bound && !!state && bound.length === state.length && timingSafeEqual(Buffer.from(bound), Buffer.from(state));

    const user = viaHandoff ? null : await resolveToken(db, readCookie(c));
    if (!viaHandoff && !user) {
      if (bound !== undefined) return c.html(failedPage('This sign-in was started for a different link. Start again from the app.'), 400);
      return c.json({ error: 'not authenticated' }, 401);
    }
    const fail = (message: string) =>
      viaHandoff ? c.html(failedPage(message), 400) : c.redirect(`/integrations?error=${encodeURIComponent(message)}`);

    if (error) return fail(error_description ?? error);
    if (!code || !state) return fail('the vendor sent no code back');
    try {
      const { entry, teamId } = await completeFlow(db, { userId: user?.id ?? null, code, state, publicUrl: PUBLIC_URL });
      const back = `/integrations?connected=${encodeURIComponent(entry.id)}${teamId ? `&team=${encodeURIComponent(teamId)}` : ''}`;
      return viaHandoff ? c.html(donePage(entry.name)) : c.redirect(back);
    } catch (err) {
      if (err instanceof OAuthError) return fail(err.message);
      throw err;
    }
  });

  /* ---- team integrations (M30, ADR 0028): credentials the team shares ---- */

  /**
   * Every member sees what the team has connected — never a credential. Only owners
   * see who has been using them: that record exists for whoever answers for the
   * shared account.
   */
  app.get('/api/teams/:id/connections', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    return c.json({
      connections: await listTeamConnections(db, teamId),
      canManage: role === 'owner',
      uses: role === 'owner' ? await teamConnectionUses(db, teamId) : [],
      // Every member may know how long who-used-what is kept (M43).
      callRecordDays: await callRecordDays(db, teamId),
      encryptionConfigured: isEncryptionConfigured(),
    });
  });

  /** M43: team owners choose how long call records are kept. */
  /* ---- M60 (ADR 0058): the trail. Owners read their organization's; a person their own. ---- */

  app.get('/api/teams/:id/audit', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    if ((await teamRole(db, teamId, c.get('user').id)) !== 'owner') return c.notFound();
    const q = c.req.query();
    const filter = {
      limit: q.limit ? Number(q.limit) : undefined,
      before: q.before ? new Date(q.before) : undefined,
      since: q.since ? new Date(q.since) : undefined,
      action: q.action || undefined,
    };
    const events = await auditForTeam(db, teamId, filter);
    if (q.format === 'csv') {
      return new Response(auditCsv(events), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="activity-${new Date().toISOString().slice(0, 10)}.csv"`,
          'Cache-Control': 'no-store',
        },
      });
    }
    return c.json({ events, auditDays: await getAuditDays(db, teamId), choices: AUDIT_DAYS });
  });

  app.put('/api/teams/:id/audit-days', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    if (role !== 'owner') return c.json({ error: 'only organization owners choose how long the trail is kept' }, 403);
    const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as { days?: unknown });
    const days = Number(body.days);
    if (!(AUDIT_DAYS as readonly number[]).includes(days)) return c.json({ error: `choose one of ${AUDIT_DAYS.join(', ')} days` }, 400);
    await setAuditDays(db, teamId, days);
    trail(c, { action: 'team.audit_days_changed', teamId, detail: { days } });
    return c.json({ auditDays: days });
  });

  /* ---- M63 (ADR 0058 amended): how long an organization keeps what its rooms hold ---- */

  app.get('/api/teams/:id/retention', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    if ((await teamRole(db, teamId, c.get('user').id)) !== 'owner') return c.notFound();
    const policy = await getRetention(db, teamId);
    return policy ? c.json({ ...policy, choices: RETENTION_DAYS }) : c.notFound();
  });

  app.put('/api/teams/:id/retention', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    if (role !== 'owner') return c.json({ error: 'only organization owners choose how long its rooms keep things' }, 403);
    type RetentionBody = Partial<Record<'messageDays' | 'outputDays' | 'fileDays', unknown>>;
    const body = await c.req.json<RetentionBody>().catch(() => ({}) as RetentionBody);
    const policy: Partial<{ messageDays: number | null; outputDays: number | null; fileDays: number | null }> = {};
    for (const k of ['messageDays', 'outputDays', 'fileDays'] as const) {
      if (k in body) policy[k] = body[k] === null ? null : Number(body[k]);
    }
    const r = await setRetention(db, teamId, policy);
    if (!r.ok) return c.json({ error: r.error }, 400);
    trail(c, { action: 'team.retention_changed', teamId, detail: { ...r.policy, prunedMessages: r.pruned.messages, prunedOutputs: r.pruned.outputs, prunedFiles: r.pruned.files } });
    return c.json({ ...r.policy, pruned: r.pruned, choices: RETENTION_DAYS });
  });

  app.get('/api/me/audit', requireUser(db), async (c) => {
    const limit = c.req.query('limit') ? Number(c.req.query('limit')) : 50;
    return c.json({ events: await auditForUser(db, c.get('user').id, { limit }) });
  });

  app.put('/api/teams/:id/call-records', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    if (role !== 'owner') return c.json({ error: 'only organization owners choose how long call records are kept' }, 403);
    const body = await c.req.json<{ days?: unknown }>().catch(() => ({}) as { days?: unknown });
    const days = Number(body.days);
    if (!(CALL_RECORD_DAYS as readonly number[]).includes(days)) {
      return c.json({ error: `choose one of ${CALL_RECORD_DAYS.join(', ')} days` }, 400);
    }
    await setCallRecordDays(db, teamId, days);
    return c.json({ callRecordDays: days });
  });

  /** Team owners only: a team credential lends access to everyone on the team. */
  app.post('/api/teams/:id/connections', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    if (role !== 'owner') return c.json({ error: 'only organization owners can add organization integrations' }, 403);
    const gated = await gateWrite(c, { teamId, ownerUserId: c.get('user').id }, 'integration');
    if (gated) return gated;
    const body = await c.req.json<{ slug?: string; label?: string; url?: string; credential?: string }>();
    if (!body.slug || !body.url) return c.json({ error: 'slug and url are required' }, 400);
    trail(c, { action: 'connection.attached', teamId, detail: { slug: body.slug, shared: true } });
    const saved = await saveTeamConnection(db, { teamId, userId: c.get('user').id, slug: body.slug, label: body.label, url: body.url, credential: body.credential });
    return saved.ok ? c.json(saved.connection, 201) : c.json({ error: saved.error }, 400);
  });

  app.delete('/api/teams/:id/connections/:slug', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    const role = await teamRole(db, teamId, c.get('user').id);
    if (!role) return c.notFound();
    if (role !== 'owner') return c.json({ error: 'only organization owners can remove organization integrations' }, 403);
    const removed = await removeTeamConnection(db, teamId, c.req.param('slug'));
    if (removed) trail(c, { action: 'connection.removed', teamId, detail: { slug: c.req.param('slug'), shared: true } });
    return removed ? c.json({ ok: true }) : c.notFound();
  });

  /* ---- chats (M29, ADR 0026): team chats and direct chats, light sessions ---- */

  app.get('/api/teams/:id/chats', requireUser(db), async (c) => {
    if (!(await teamRole(db, c.req.param('id'), c.get('user').id))) return c.notFound();
    return c.json(await listTeamChats(db, c.req.param('id'), c.get('user').id));
  });

  /** Any team member may add a chat; everyone on the team is in it. */
  app.post('/api/teams/:id/chats', requireUser(db), async (c) => {
    const teamId = c.req.param('id');
    if (!(await teamRole(db, teamId, c.get('user').id))) return c.notFound();
    const gatedChat = await gateWrite(c, { teamId, ownerUserId: c.get('user').id }, 'room');
    if (gatedChat) return gatedChat;
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    try {
      return c.json(await createChat(db, { teamId, userId: c.get('user').id, name: name ?? '' }), 201);
    } catch (err) {
      if (err instanceof ChatError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /** Open (or create) the 1:1 chat with someone you share a team with. */
  app.post('/api/directs', requireUser(db), async (c) => {
    const { userId } = await c.req.json<{ userId?: string }>().catch(() => ({ userId: undefined }));
    try {
      return c.json(await openDirect(db, c.get('user').id, userId ?? ''));
    } catch (err) {
      if (err instanceof ChatError) return c.json({ error: err.message }, err.message === 'no such person' ? 404 : 400);
      throw err;
    }
  });

  app.get('/api/directs/people', requireUser(db), async (c) => c.json(await directCandidates(db, c.get('user').id)));

  /* ---- the local host (M31, ADR 0027): pairing and devices ---- */

  /** Unauthenticated: the host asks to pair and gets a code for a person to confirm. */
  app.post('/api/devices/pair', async (c) => {
    const { name } = await c.req.json<{ name?: string }>().catch(() => ({ name: undefined }));
    return c.json(await startPairing(db, name ?? ''), 201);
  });

  /** Unauthenticated: the host polls; once confirmed it receives its token, once. */
  app.post('/api/devices/pair/poll', async (c) => {
    const { deviceCode } = await c.req.json<{ deviceCode?: string }>().catch(() => ({ deviceCode: undefined }));
    return c.json(await pollPairing(db, deviceCode ?? ''));
  });

  /** What the /pair page shows: the device's name for a live code. */
  app.get('/api/devices/pair/:code', requireUser(db), async (c) => {
    const p = await describePairing(db, c.req.param('code'));
    return p ? c.json(p) : c.notFound();
  });

  app.post('/api/devices/pair/confirm', requireUser(db), async (c) => {
    const { code } = await c.req.json<{ code?: string }>().catch(() => ({ code: undefined }));
    try {
      return c.json(await confirmPairing(db, c.get('user').id, code ?? ''));
    } catch (err) {
      if (err instanceof DeviceError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.get('/api/devices', requireUser(db), async (c) => c.json(await listDevices(db, c.get('user').id, hostHub.online)));

  /**
   * M54 (ADR 0052): ask one of your online computers to open its Folders window
   * with an organization preselected. No path, no policy travels: the person
   * chooses both on the machine.
   */
  app.post('/api/devices/:id/open-folders', requireUser(db), async (c) => {
    const { teamId } = await c.req.json<{ teamId?: string }>();
    if (!teamId || !(await teamRole(db, teamId, c.get('user').id))) return c.json({ error: 'no such organization' }, 404);
    const device = (await listDevices(db, c.get('user').id, hostHub.online)).find((d) => d.id === c.req.param('id'));
    if (!device) return c.notFound();
    if (!device.online) return c.json({ error: `${device.name} is offline` }, 409);
    hostHub.send(device.id, { type: 'open_folders', org: teamId });
    return c.json({ ok: true });
  });

  app.delete('/api/devices/:id', requireUser(db), async (c) => {
    const done = await revokeDevice(db, c.get('user').id, c.req.param('id'));
    if (!done) return c.notFound();
    hostHub.kick(c.req.param('id'));
    return c.json({ ok: true });
  });

  const sessionRoutes = new Hono<AuthEnv>();

  sessionRoutes.use('*', requireUser(db));

  /**
   * ADR 0041: every write in a room asks the deployment's write check first.
   * Default-deny: anything not listed as exempt is a write. Exempt is what a
   * gated team must still be able to do: mark read, set notifications, pause
   * agents, revoke, leave, and remove things.
   */
  const NEVER_GATED: [string, RegExp][] = [
    ['POST', /^\/seen$/],
    ['PUT', /^\/notify$/],
    ['POST', /^\/pause$/],
    ['POST', /^\/tokens\/[^/]+\/revoke$/],
    ['POST', /^\/invites\/[^/]+\/revoke$/],
  ];
  const ACTIONS: [RegExp, string][] = [
    [/^\/messages/, 'message'],
    [/^\/agents|^\/tokens|^\/pause/, 'agent'],
    [/^\/artifacts/, 'upload'],
    [/^\/context|^\/links/, 'context'],
    [/^\/outputs/, 'output'],
    [/^\/integrations/, 'integration'],
    [/^\/invites|^\/members|^\/guests|^\/team/, 'member'],
  ];
  sessionRoutes.use('*', async (c, next) => {
    const method = c.req.method;
    if (method === 'GET' || method === 'HEAD' || !writesGuarded()) return next();
    const sub = c.req.path.replace(/^\/api\/o\/[^/]+\/s\/[^/]+/, '') || '/';
    // Removing is never gated, except DELETE /pause, which resumes agents.
    if (method === 'DELETE' && sub !== '/pause') return next();
    if (NEVER_GATED.some(([m, re]) => m === method && re.test(sub))) return next();
    const scope = await roomScopeByPublicId(db, c.req.param('session') ?? '');
    if (!scope) return next(); // The route answers 404 itself.
    const action = ACTIONS.find(([re]) => re.test(sub))?.[1] ?? 'room';
    return (await gateWrite(c, scope, action)) ?? next();
  });

  sessionRoutes.get('/', async (c) => {
    // Readable by viewers (M22) — but a viewer's view leaves out the member list
    // (emails) and everything Setup holds (docs/security.md, Threat 8).
    const s = await resolveViewer(c);
    if (!s) return c.notFound();

    const statuses = await connectionStatuses(db, s.id);
    // M15 slice 1: what a blocked agent waits on, so the room can say so.
    const blocked = await blockedOn(db, s.id);
    const viewer = s.access === 'viewer';
    const view: SessionView = {
      agents: await pauseState(db, s.id),
      session: s.view,
      participants: (await listParticipants(db, s.id)).map((p) => ({
        ...p,
        status: statuses.get(p.id),
        blocked: blocked.get(p.id) ?? null,
      })),
      members: viewer ? [] : await membersWithOrigin(s.id),
      me: { role: s.role, participantId: s.participantId },
      mcpEndpoint: viewer ? '' : `${PUBLIC_URL}/mcp/o/${s.view.ownerSlug}/s/${s.view.publicId}`,
      visibility: await getVisibility(db, s.id),
      ...(s.role === 'owner' ? { guests: await listGuests(db, s.id) } : {}),
    };
    return c.json(view);
  });

  sessionRoutes.patch('/', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    // Only owners mutate the session itself. A member gets 404 rather than 403:
    // from their perspective the mutable resource does not exist.
    if (s.role !== 'owner') return c.notFound();

    const body = await c.req.json<{ title?: string; status?: 'active' | 'archived'; visibility?: string }>();

    // M22: making a session team-visible is the owner's deliberate act.
    if (body.visibility !== undefined) {
      if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);
      const set = await setVisibility(db, s.id, body.visibility as 'private' | 'team');
      if (!set.ok) return c.json({ error: set.error }, 400);
    }

    if (body.title !== undefined) {
      const title = body.title.trim();
      if (!title) return c.json({ error: 'title cannot be empty' }, 400);
      await renameSession(db, s.id, title);
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'archived') {
        return c.json({ error: 'status must be active or archived' }, 400);
      }
      await setSessionStatus(db, s.id, body.status);
    }

    return c.json({ ok: true });
  });

  sessionRoutes.delete('/', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const teamId = (await roomScope(db, s.id))?.teamId ?? null;
    await deleteSession(db, s.id);
    // The row is gone, so the event names the room by title and public id.
    trail(c, { action: 'session.deleted', teamId, detail: { title: s.view.title, publicId: s.view.publicId } });
    return c.json({ ok: true });
  });

  sessionRoutes.get('/messages', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await listMessages(db, s.id));
  });

  sessionRoutes.post('/messages', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const body = await c.req.json<PostMessageBody>();
    const content = body.content?.trim();
    if (!content) return c.json({ error: 'content is required' }, 400);

    // The author is the caller's own participant row — never client-supplied.
    const result = await createMessage(
      db,
      s.id,
      s.participantId,
      content,
      body.mentions,
    );
    // A mention referencing another session's participant is refused, not dropped.
    if (!result.ok) return c.json({ error: result.error }, 400);

    publish(s.id, { type: 'message.created', message: result.message });
    // Mentions of agents are evaluated and pushed here, not in the bridge. A
    // failure here must not lose the message that was already stored — but it must
    // also not be swallowed, because silent non-delivery is the failure mode this
    // whole subsystem exists to avoid (ADR 0010).
    await deliverMentions(db, s.id, result.message).catch((err) => {
      console.error('[delivery] failed for message', result.message.id, err);
    });

    return c.json(result.message, 201);
  });

  /* ---- participants ---- */

  sessionRoutes.get('/participants', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await listParticipants(db, s.id));
  });

  /**
   * Rename a participant.
   *
   * You may rename yourself in any session you're in; a session owner may rename
   * anyone, which is what agents will need at M3. Stored message content holds
   * ids, so old messages pick up the new name immediately (ADR 0008).
   */
  sessionRoutes.patch('/participants/:id', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const targetId = c.req.param('id');
    const isSelf = targetId === s.participantId;
    // Not your participant and not your session: as far as you're concerned it
    // isn't there.
    if (!isSelf && s.role !== 'owner') return c.notFound();

    const body = await c.req.json<RenameParticipantBody>();
    const result = await renameParticipant(db, s.id, targetId, body.displayName ?? '');

    if (!result.ok) {
      if (result.error === 'no such participant in this session') return c.notFound();
      return c.json({ error: result.error }, result.conflict ? 409 : 400);
    }

    publish(s.id, { type: 'participant.updated', participant: result.participant });
    return c.json(result.participant);
  });

  /* ---- members ---- */

  sessionRoutes.get('/members', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    return c.json(await membersWithOrigin(s.id));
  });

  sessionRoutes.delete('/members/:userId', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    // A team chat's members are the team (ADR 0026): leave the team to leave it.
    if (s.view.kind === 'chat') return c.json({ error: "an organization chat's members are the organization" }, 400);

    const userId = c.req.param('userId');
    const members = await listMembers(db, s.id);
    const target = members.find((m) => m.userId === userId);
    if (!target) return c.notFound();

    // Refuse to leave a session ownerless — it would be unreachable and
    // unmanageable, with no path to recover it through the API.
    if (target.role === 'owner' && (await countOwners(db, s.id)) <= 1) {
      return c.json({ error: 'a session must keep at least one owner' }, 409);
    }

    await removeMember(db, s.id, userId);
    trail(c, { action: 'member.removed', sessionId: s.id, subjectUserId: userId, detail: { role: target.role } });
    return c.json({ ok: true });
  });

  /* ---- since you were away (M24). Viewers too: catch-up only reads, and "seen"
     writes nothing but the caller's own read position. ---- */

  sessionRoutes.get('/catch-up', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await getCatchUp(db, s.id, c.get('user').id));
  });

  sessionRoutes.post('/seen', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    await markSeen(db, s.id, c.get('user').id);
    // M42: your other open pages drop this room's number too.
    void refreshRoom(db, c.get('user').id, s.id).catch(() => {});
    return c.json({ ok: true });
  });

  /** M42 (ADR 0037): how much of this room reaches you. null = the kind's default. */
  sessionRoutes.put('/notify', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ notify?: unknown }>().catch(() => ({}) as { notify?: unknown });
    const notify = body.notify ?? null;
    if (notify !== null && notify !== 'everything' && notify !== 'needs_you' && notify !== 'nothing') {
      return c.json({ error: 'notify is everything, needs_you, nothing or null' }, 400);
    }
    await setNotify(db, s.id, c.get('user').id, notify as NotifySetting | null);
    void refreshRoom(db, c.get('user').id, s.id).catch(() => {});
    const [room] = await listSessionsForUser(db, c.get('user').id, s.id);
    return c.json({ notify: room?.notify ?? notify });
  });

  /* ---- this session's template (M25) ---- */

  /** Which template it started from, for suggested connections. Members only. */
  sessionRoutes.get('/template', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    return c.json(await sessionTemplate(db, c.get('user').id, s.id));
  });

  /** Save this session's structure as a template. The owner's call. */
  sessionRoutes.post('/template', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const body = await c.req.json<{ name?: string; description?: string; teamId?: string | null }>();
    try {
      return c.json(
        await saveTemplate(db, { sessionId: s.id, userId: c.get('user').id, name: body.name ?? '', description: body.description, teamId: body.teamId ?? null }),
        201,
      );
    } catch (err) {
      if (err instanceof TemplateError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /* ---- export (M27): the record is yours. The owner's deliberate act. ---- */

  sessionRoutes.get('/export', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const { filename, data } = await exportSession(db, {
      sessionId: s.id,
      session: { title: s.view.title, publicId: s.view.publicId, ownerSlug: s.view.ownerSlug, createdAt: s.view.createdAt },
      exportedBy: c.get('user').displayName,
    });
    trail(c, { action: 'session.exported', sessionId: s.id, detail: { title: s.view.title } });
    // An ASCII fallback, and the real name per RFC 5987 for anything that reads it.
    const ascii = filename.replace(/[^\x20-\x7e]/g, '-').replace(/"/g, '');
    return new Response(new Uint8Array(data), {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  });

  /* ---- start a session from a chat (M29): a link back, nothing copied ---- */

  sessionRoutes.post('/spin-off', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    if ((s.view.kind ?? 'session') === 'session') return c.json({ error: 'this is already a session' }, 400);
    const { title } = await c.req.json<{ title?: string }>();
    if (!title?.trim()) return c.json({ error: 'title is required' }, 400);
    const created = await createSession(db, c.get('user'), title.trim(), { teamId: s.view.kind === 'chat' ? (s.view.teamId ?? null) : null });
    const fresh = await resolveSessionForUser(db, created.ownerSlug, created.publicId, c.get('user').id);
    await saveLink(db, {
      sessionId: fresh!.id,
      participantId: fresh!.participantId,
      input: {
        url: `${PUBLIC_URL}/o/${s.view.ownerSlug}/s/${s.view.publicId}`,
        type: 'page',
        title: s.view.kind === 'chat' ? `Started from #${s.view.title}` : 'Started from a direct chat',
        provider: 'fabrikka',
      },
    });
    return c.json(created, 201);
  });

  /* ---- "Add my agent" (M31): an agent that runs on one of your paired devices ---- */

  sessionRoutes.post('/agents/host', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ deviceId?: string; grantId?: string; displayName?: string; provider?: string }>();
    try {
      const agent = await bindAgent(db, {
        sessionTeamId: (await sessionTeam(db, s.id))?.id ?? null,
        sessionId: s.id,
        sessionPublicId: s.view.publicId,
        ownerSlug: s.view.ownerSlug,
        publicUrl: PUBLIC_URL,
        user: c.get('user'),
        deviceId: body.deviceId ?? '',
        grantId: body.grantId ?? '',
        displayName: body.displayName,
        // M35: Claude Code or Codex, when the computer has both; else whichever it has.
        provider: body.provider,
      });
      // Only the new binding goes out, with its own token: re-minting the others
      // would revoke tokens that running agents are using.
      const [binding] = await bindingsForDevice(db, body.deviceId!, PUBLIC_URL, agent.sessionAgentId);
      if (binding) hostHub.send(body.deviceId!, { type: 'binding', binding });
      return c.json({ agent, online: hostHub.online(body.deviceId!) }, 201);
    } catch (err) {
      if (err instanceof DeviceError) return c.json({ error: err.message }, err.message === 'no such device' ? 404 : 400);
      throw err;
    }
  });

  /** Where each of this session's agents runs, for agents bound to a device. */
  sessionRoutes.get('/agents/hosts', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const out: Record<string, { deviceName: string; label: string | null; online: boolean; fromPersonal: boolean }> = {};
    const inOrg = (await sessionTeam(db, s.id)) !== null;
    for (const a of await listSessionAgents(db, s.id)) {
      const h = await hostOf(db, a.sessionAgentId);
      // ADR 0043: a Personal folder bound here before folders had organizations.
      if (h) out[a.participantId] = { deviceName: h.deviceName, label: h.label, online: hostHub.online(h.deviceId), fromPersonal: h.fromPersonal && inOrg };
    }
    return c.json(out);
  });

  /* ---- guests (M22): a viewer of this one session, from outside its team ---- */

  sessionRoutes.delete('/guests/:userId', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const removed = await removeGuest(db, s.id, c.req.param('userId'));
    if (removed) trail(c, { action: 'guest.removed', sessionId: s.id, subjectUserId: c.req.param('userId') });
    return removed ? c.json({ ok: true }) : c.notFound();
  });

  /* ---- the session's team (M21) ---- */

  /** Any member may see which team a session is in; only the owner may change it. */
  sessionRoutes.get('/team', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    return c.json(await sessionTeam(db, s.id));
  });

  // ADR 0050: there is no PUT /team. A session's organization is fixed at creation.

  /** Teammates not yet in the session. Owner only: adding is the owner's call. */
  sessionRoutes.get('/roster', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    return c.json(await roster(db, s.id));
  });

  /** Add a teammate directly — no link, because the server knows who they are. */
  sessionRoutes.post('/members', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    // Chats (M29) don't take invites, roster adds, a team change or visibility.
    if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);
    const { userId } = await c.req.json<{ userId?: string }>();
    try {
      await addFromRoster(db, s.id, userId ?? '');
    } catch (err) {
      if (err instanceof TeamError) return c.json({ error: err.message }, 400);
      throw err;
    }
    trail(c, { action: 'member.added', sessionId: s.id, subjectUserId: userId ?? null, detail: { from: 'roster' } });
    return c.json({ ok: true }, 201);
  });

  /* ---- agents ---- */

  sessionRoutes.get('/agents', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    return c.json(await listSessionAgents(db, s.id));
  });

  /**
   * Add an agent and issue its token in one step.
   *
   * Returns the plaintext token exactly once, plus a ready-to-paste
   * `claude mcp add` command — the point of M3 is that connecting an agent is one
   * copy-paste, not a configuration exercise.
   */
  sessionRoutes.post('/agents', async (c) => {
    const s = await resolve(c);
    // ANY member may add their OWN agent. Agents are per-user (agents.owner_id),
    // and the multi-participant story requires @claude-fede and @claude-alice to
    // coexist — if only the session owner could add one, Alice could never bring
    // an agent or, by ADR 0004, her own credentials.
    if (!s) return c.notFound();

    type Body = { displayName?: string; provider?: string; label?: string };
    const body: Body = await c.req.json<Body>().catch(() => ({}));
    const displayName = body.displayName?.trim();
    if (!displayName) return c.json({ error: 'displayName is required' }, 400);

    const result = await addAgentToSession(db, {
      sessionId: s.id,
      ownerUserId: c.get('user').id,
      displayName,
      provider: body.provider?.trim() || 'other',
      label: body.label,
      publicUrl: PUBLIC_URL,
      ownerSlug: s.view.ownerSlug,
      sessionPublicId: s.view.publicId,
    });
    if (!result.ok) return c.json({ error: result.error }, 409);

    const { agent, token, mcpUrl } = result.created;
    publish(s.id, {
      type: 'participant.updated',
      participant: {
        id: agent.participantId,
        sessionId: s.id,
        kind: 'agent',
        displayName: agent.displayName,
      },
    });
    trail(c, { action: 'agent.added', sessionId: s.id, detail: { agent: agent.displayName, provider: agent.provider } });

    return c.json({ ...agentSetup(mcpUrl, token, agent.provider), agent }, 201);
  });

  sessionRoutes.patch('/agents/:sessionAgentId/trust', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const { trustTier } = await c.req.json<{ trustTier?: string }>();
    if (trustTier !== 'owner_only' && trustTier !== 'session_trusted') {
      return c.json({ error: 'trustTier must be owner_only or session_trusted' }, 400);
    }

    // Elevating an agent decides who may drive something that holds ITS OWNER's
    // filesystem and tokens. That is the agent owner's call, not the session
    // owner's — a session owner must not be able to open up someone else's agent.
    const agents = await listSessionAgents(db, s.id);
    const target = agents.find((a) => a.sessionAgentId === c.req.param('sessionAgentId'));
    if (!target) return c.notFound();
    if (target.ownerUserId !== c.get('user').id) return c.notFound();

    const done = await setAgentTrustTier(db, s.id, c.req.param('sessionAgentId'), trustTier);
    if (!done) return c.notFound();
    trail(c, { action: 'agent.trust_changed', sessionId: s.id, detail: { agent: target.displayName, trustTier } });
    return c.json({ ok: true });
  });

  /**
   * Whether this agent's steps are streamed to the session.
   *
   * The AGENT OWNER's call, like trust elevation: it is their machine and their
   * private work being described, not the session's (ADR 0015).
   */
  sessionRoutes.patch('/agents/:sessionAgentId/activity', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const { visible } = await c.req.json<{ visible?: boolean }>();
    if (typeof visible !== 'boolean') {
      return c.json({ error: 'visible must be a boolean' }, 400);
    }

    const agentList = await listSessionAgents(db, s.id);
    const target = agentList.find((a) => a.sessionAgentId === c.req.param('sessionAgentId'));
    if (!target) return c.notFound();
    if (target.ownerUserId !== c.get('user').id) return c.notFound();

    const done = await setActivityVisible(db, s.id, c.req.param('sessionAgentId'), visible);
    if (!done) return c.notFound();
    return c.json({ ok: true });
  });

  /* ---- tokens ---- */

  sessionRoutes.get('/tokens', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    return c.json(await listSessionTokens(db, s.id));
  });

  sessionRoutes.post('/tokens', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();

    const body = await c.req
      .json<{ participantId?: string; label?: string }>()
      .catch(() => ({}) as { participantId?: string; label?: string });
    if (!body.participantId) return c.json({ error: 'participantId is required' }, 400);

    const token = await issueToken(db, {
      sessionId: s.id,
      participantId: body.participantId,
      createdByUserId: c.get('user').id,
      label: body.label,
    });
    if (!token) return c.notFound();

    const mcpUrl = `${PUBLIC_URL}/mcp/o/${s.view.ownerSlug}/s/${s.view.publicId}`;
    // The lane set depends on the provider, so it comes from the participant's
    // agent record rather than being guessed.
    const agents = await listSessionAgents(db, s.id);
    const provider =
      agents.find((a) => a.participantId === body.participantId)?.provider ?? 'other';
    trail(c, { action: 'token.issued', sessionId: s.id, detail: { participantId: body.participantId, label: body.label ?? null } });
    return c.json(agentSetup(mcpUrl, token, provider), 201);
  });

  sessionRoutes.post('/tokens/:id/revoke', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const done = await revokeToken(db, s.id, c.req.param('id'));
    if (!done) return c.notFound();
    trail(c, { action: 'token.revoked', sessionId: s.id, detail: { tokenId: c.req.param('id') } });
    return c.json({ ok: true });
  });

  /* ---- safety rails ---- */

  sessionRoutes.get('/pause', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    return c.json(await pauseState(db, s.id));
  });

  /**
   * The kill switch.
   *
   * Any member can pull it: if an agent is misbehaving, waiting for the owner is
   * the wrong failure mode. Halting delivery is absolute; aborting in-flight runs
   * is a request the runners may or may not honour (ADR 0012).
   */
  sessionRoutes.post('/pause', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    await setPaused(db, s.id, true, 'manual');
    const asked = broadcastAbort(s.id);
    trail(c, { action: 'agents.paused', sessionId: s.id, detail: { connectionsAskedToAbort: asked } });

    return c.json({ ...(await pauseState(db, s.id)), connectionsAskedToAbort: asked });
  });

  sessionRoutes.delete('/pause', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    await setPaused(db, s.id, false);
    trail(c, { action: 'agents.resumed', sessionId: s.id });
    return c.json(await pauseState(db, s.id));
  });

  /* ---- context ---- */

  sessionRoutes.get('/context', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await getSessionContext(db, s.id));
  });

  sessionRoutes.patch('/context', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const body = await c.req.json<ContextUpdate>();
    const result = await updateSessionContext(db, s.id, body, { participantId: s.participantId });

    // 409 rather than a silent overwrite: the browser reloads and shows what
    // changed, instead of one of two people's edits disappearing (ADR 0013).
    if (!result.ok) {
      return c.json(
        { error: result.error, currentVersion: result.currentVersion },
        result.conflict ? 409 : 400,
      );
    }

    publish(s.id, { type: 'context.updated', context: result.context });
    return c.json(result.context);
  });

  /* ---- integrations (MCP aggregation) ---- */

  /**
   * What THIS member has attached, plus which integrations exist in the session.
   *
   * Deliberately two lists: you see your own credentials' servers, and you see that
   * an integration exists so grants make sense — but never whose credential is
   * behind someone else's.
   */
  sessionRoutes.get('/integrations', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const mine = await serversForUser(db, s.id, c.get('user').id);
    return c.json({
      mine,
      // M30: the team's shared connections that apply to YOU here — empty unless the
      // session is a team's and you're on it. `overridden`: your own wins.
      team: (await teamServersFor(db, s.id, c.get('user').id)).map((t) => ({
        slug: t.slug,
        label: t.label,
        teamName: t.team!.name,
        hasCredential: t.hasCredential,
        overridden: mine.some((m) => m.slug === t.slug),
      })),
      // M28: your connections not yet in this session, offered to attach. ADR 0043 (amended):
      // the room's organization's and your all-rooms ones, one per vendor.
      available: (await usableConnections(db, c.get('user').id, await roomScopeOf(db, s.id))).filter((x) => !mine.some((m) => m.id === x.id)),
      inSession: await slugsInSession(db, s.id),
      grants: await listGrants(db, s.id),
      encryptionConfigured: isEncryptionConfigured(),
    });
  });

  sessionRoutes.post('/integrations', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const body = await c.req.json<{
      slug?: string;
      label?: string;
      url?: string;
      credential?: string;
    }>();
    // A url saves (or updates) the connection; a slug alone attaches one you
    // already have, from Personal integrations (M28).
    if (!body.slug) return c.json({ error: 'slug is required' }, 400);

    const result = await attachServer(db, {
      sessionId: s.id,
      userId: c.get('user').id,
      slug: body.slug,
      label: body.label,
      url: body.url,
      credential: body.credential,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);

    // M52 (ADR 0049): the OWNER's default fills in grants the room doesn't have
    // yet. A member's attach changes nothing: a member cannot set grants.
    let defaultApplied: number | null = null;
    if (s.role === 'owner' && !(await hasGrants(db, s.id, result.server.slug))) {
      defaultApplied = await applyGrantDefault(db, s.id, c.get('user').id, result.server.slug);
    }
    trail(c, { action: 'connection.attached', sessionId: s.id, detail: { slug: result.server.slug, shared: false, defaultApplied } });
    return c.json({ ...result.server, defaultApplied }, 201);
  });

  /** M52: make this room's grants for a slug exactly the caller's saved default. Owner-only. */
  sessionRoutes.post('/integrations/:slug/grants/apply-default', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const applied = await applyGrantDefault(db, s.id, c.get('user').id, c.req.param('slug'));
    if (applied === null) return c.json({ error: 'no default saved for that connection' }, 404);
    trail(c, { action: 'grant.changed', sessionId: s.id, detail: { slug: c.req.param('slug'), preset: 'default', allowed: applied } });
    return c.json({ ok: true, allowed: applied });
  });

  sessionRoutes.delete('/integrations/:slug', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const done = await detachServer(db, s.id, c.get('user').id, c.req.param('slug'));
    if (!done) return c.notFound();
    trail(c, { action: 'connection.removed', sessionId: s.id, detail: { slug: c.req.param('slug'), shared: false } });
    return c.json({ ok: true });
  });

  /** Tools an integration offers, so an owner can choose what to permit. */
  sessionRoutes.get('/integrations/:slug/tools', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    // Your own, or your team's where you have none (M30) — whichever you'd use.
    const usable = await usableServers(db, s.id, c.get('user').id);
    const server = usable.find((m) => m.slug === c.req.param('slug'));
    if (!server) return c.notFound();

    return c.json(await discoverTools(db, server));
  });

  /**
   * Grant or revoke one tool for the whole session.
   *
   * Owner-only, and keyed by the integration's slug rather than by whose row it is:
   * what the session permits is a property of the session (ADR 0014).
   */
  sessionRoutes.put('/integrations/:slug/tools/:tool', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();

    const { allowed } = await c.req.json<{ allowed?: boolean }>();
    await setGrant(db, s.id, c.req.param('slug'), c.req.param('tool'), allowed === true);
    trail(c, { action: 'grant.changed', sessionId: s.id, detail: { slug: c.req.param('slug'), tool: c.req.param('tool'), allowed: allowed === true } });
    return c.json({ ok: true });
  });

  /**
   * M18: a grant preset — Read, Read & write, or None — for a catalogue
   * connection. A shortcut over the per-tool grants above, never a new permission
   * model: it sets exactly the entry's classified tools, and a tool no entry
   * classifies stays as it was (ADR 0024).
   */
  sessionRoutes.put('/integrations/:slug/preset', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    const { preset } = await c.req.json<{ preset?: string }>();
    if (!['none', 'read', 'write'].includes(String(preset))) return c.json({ error: 'preset is none, read or write' }, 400);
    const slug = c.req.param('slug');
    const entries = offeredEntries().filter((e) => e.slug === slug && e.presets);
    if (!entries.length) return c.json({ error: 'no presets for that connection' }, 404);
    const read = new Set(entries.flatMap((e) => e.presets!.read));
    const write = new Set(entries.flatMap((e) => e.presets!.write));
    for (const tool of read) await setGrant(db, s.id, slug, tool, preset !== 'none');
    for (const tool of write) await setGrant(db, s.id, slug, tool, preset === 'write');
    trail(c, { action: 'grant.changed', sessionId: s.id, detail: { slug, preset: String(preset) } });
    return c.json({ ok: true, read: read.size, write: preset === 'write' ? write.size : 0 });
  });

  /* ---- artifacts ---- */

  sessionRoutes.get('/artifacts', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await listArtifacts(db, s.id));
  });

  sessionRoutes.post('/artifacts', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();

    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) return c.json({ error: 'no file provided' }, 400);

      const result = await createFileArtifact(db, {
        sessionId: s.id,
        participantId: s.participantId,
        name: (form.name as string) || file.name,
        contentType: file.type || null,
        content: Buffer.from(await file.arrayBuffer()),
      });
      if (!result.ok) return c.json({ error: result.error }, 400);

      publish(s.id, { type: 'artifact.created', artifact: result.artifact });
      return c.json(result.artifact, 201);
    }

    const body = await c.req.json<{ name?: string; url?: string }>();
    if (!body.url) return c.json({ error: 'a url is required for a link' }, 400);

    const result = await createLinkArtifact(db, {
      sessionId: s.id,
      participantId: s.participantId,
      name: body.name ?? body.url,
      url: body.url,
    });
    if (!result.ok) return c.json({ error: result.error }, 400);

    publish(s.id, { type: 'artifact.created', artifact: result.artifact });
    return c.json(result.artifact, 201);
  });

  sessionRoutes.get('/artifacts/:id/content', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();

    const found = await readArtifact(db, s.id, c.req.param('id'));
    if (!found) return c.notFound();

    return new Response(new Uint8Array(found.content), {
      headers: {
        'Content-Type': found.artifact.contentType ?? 'application/octet-stream',
        // Always an attachment: a session file is not ours to render inline, and
        // serving arbitrary uploaded HTML from our origin would be an XSS vector.
        'Content-Disposition': `attachment; filename="${found.artifact.name.replace(/"/g, '')}"`,
      },
    });
  });

  sessionRoutes.delete('/artifacts/:id', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const done = await deleteArtifact(db, s.id, c.req.param('id'));
    if (!done) return c.notFound();
    return c.json({ ok: true });
  });

  /* ---- invites ---- */

  /* ---- links (M19): pointers to outside things. Any member, like context. ---- */

  sessionRoutes.get('/links', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await listLinks(db, s.id));
  });

  sessionRoutes.put('/links', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ url?: string; type?: string; title?: string; status?: string; provider?: string }>();
    try {
      const link = await saveLink(db, {
        sessionId: s.id,
        participantId: s.participantId,
        input: { url: body.url ?? '', type: body.type ?? '', title: body.title, status: body.status, provider: body.provider },
      });
      return c.json(link);
    } catch (err) {
      if (err instanceof LinkError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  sessionRoutes.delete('/links', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    try {
      if (!(await removeLink(db, s.id, c.req.query('url') ?? ''))) return c.notFound();
    } catch (err) {
      if (err instanceof LinkError) return c.json({ error: err.message }, 400);
      throw err;
    }
    return c.json({ ok: true });
  });

  /* ---- outputs (M12): live documents. See ADR 0019. ---- */

  /** The catalogue: what kinds of output this instance offers. */
  sessionRoutes.get('/output-kinds', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(outputKinds());
  });

  sessionRoutes.get('/outputs', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return c.json(await listOutputs(db, s.id));
  });

  sessionRoutes.post('/outputs', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ kind?: string; name?: string }>();
    try {
      const output = await createOutput(db, {
        sessionId: s.id,
        participantId: s.participantId,
        kind: body.kind ?? '',
        name: body.name ?? '',
      });
      return c.json(output, 201);
    } catch (err) {
      if (err instanceof OutputError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /** Any member may rename: a name is shared furniture, like the context. */
  sessionRoutes.patch('/outputs/:id', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const { name } = await c.req.json<{ name?: string }>();
    if (!name?.trim()) return c.json({ error: 'a name is required' }, 400);
    if (!(await renameOutput(db, s.id, c.req.param('id'), name, s.participantId))) return c.notFound();
    return c.json({ ok: true });
  });

  /**
   * Removing a document the whole room is writing is not a member's call to make
   * for everyone: its creator or the session owner. Everyone else gets 404.
   */
  sessionRoutes.delete('/outputs/:id', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const id = c.req.param('id');
    const creator = await outputCreator(db, s.id, id);
    if (!creator || (creator !== s.participantId && s.role !== 'owner')) return c.notFound();
    await deleteOutput(db, s.id, id);
    return c.json({ ok: true });
  });

  /** Files of a multi-file output (a paper's sections). Any member, like typing. */
  sessionRoutes.post('/outputs/:id/files', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const { path } = await c.req.json<{ path?: string }>();
    try {
      await addFile(db, { sessionId: s.id, outputId: c.req.param('id'), participantId: s.participantId, path: path?.trim() ?? '' });
      return c.json({ ok: true }, 201);
    } catch (err) {
      if (err instanceof OutputError) return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message }, 400);
      throw err;
    }
  });

  sessionRoutes.delete('/outputs/:id/files', async (c) => {
    const s = await resolve(c);
    if (!s) return c.notFound();
    const path = c.req.query('path') ?? '';
    try {
      await removeFile(db, { sessionId: s.id, outputId: c.req.param('id'), participantId: s.participantId, path });
      return c.json({ ok: true });
    } catch (err) {
      if (err instanceof OutputError) return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message }, 400);
      throw err;
    }
  });

  /** Each output kind's own routes: public assets, session-scoped config (ADR 0023). */
  mountKindRoutes(app, sessionRoutes, { member: resolve, viewer: resolveViewer });

  sessionRoutes.get('/outputs/:id/changes', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const id = c.req.param('id');
    if (!isOutputId(id) || !(await outputCreator(db, s.id, id))) return c.notFound();
    return c.json(await listEdits(db, s.id, { outputId: id }));
  });

  /* ---- comments on outputs (M23). Viewers and guests comment too: the one write
     on their allowlist (docs/security.md, Threat 8). A comment wakes no agent. ---- */

  async function commentCall(c: Context<AuthEnv>, fn: () => Promise<unknown>) {
    try {
      return c.json(await fn());
    } catch (err) {
      if (err instanceof OutputError) {
        return err.code === 'not_found' ? c.notFound() : c.json({ error: err.message, code: err.code }, 400);
      }
      throw err;
    }
  }

  sessionRoutes.get('/outputs/:id/comments', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    return commentCall(c, () => listComments(db, s.id, c.req.param('id')));
  });

  sessionRoutes.post('/outputs/:id/comments', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ quote?: string; body?: string; file?: string }>();
    return commentCall(c, async () => ({
      id: await addComment(db, {
        sessionId: s.id,
        outputId: c.req.param('id'),
        userId: c.get('user').id,
        file: body.file,
        quote: body.quote ?? '',
        body: body.body ?? '',
      }),
    }));
  });

  sessionRoutes.post('/outputs/:id/comments/:cid/replies', async (c) => {
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const body = await c.req.json<{ body?: string }>();
    return commentCall(c, async () => ({
      id: await reply(db, {
        sessionId: s.id,
        outputId: c.req.param('id'),
        userId: c.get('user').id,
        commentId: c.req.param('cid'),
        body: body.body ?? '',
      }),
    }));
  });

  /** Members resolve any thread; a viewer only one they started. */
  for (const action of ['resolve', 'reopen'] as const) {
    sessionRoutes.post(`/outputs/:id/comments/:cid/${action}`, async (c) => {
      const s = await resolveViewer(c);
      if (!s) return c.notFound();
      const outputId = c.req.param('id');
      const commentId = c.req.param('cid');
      if (s.access === 'viewer' && (await threadAuthor(db, s.id, outputId, commentId)) !== c.get('user').id) {
        return c.notFound();
      }
      return commentCall(c, async () => {
        await setResolved(db, { sessionId: s.id, outputId, userId: c.get('user').id, commentId, resolved: action === 'resolve' });
        return { ok: true };
      });
    });
  }

  /**
   * Recent agent edits across the session, so the timeline can show them after a
   * reload. Human typing is in each output's changes view, not the conversation.
   */
  sessionRoutes.get('/output-edits', async (c) => {
    // Readable by viewers (M22): on the allowlist in docs/security.md, Threat 8.
    const s = await resolveViewer(c);
    if (!s) return c.notFound();
    const edits = await listEdits(db, s.id, { agentsOnly: true, limit: 100 });
    return c.json(edits.map(({ diff: _diff, ...summary }) => summary));
  });

  sessionRoutes.get('/invites', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    return c.json(await listInvites(db, { sessionId: s.id }));
  });

  /**
   * Creating an invite returns the plaintext token exactly once. The UI copies
   * `url` to the clipboard; delivery is out of band, by design (ADR 0007).
   */
  sessionRoutes.post('/invites', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();
    // Chats (M29) don't take invites, roster adds, a team change or visibility.
    if ((s.view.kind ?? 'session') !== 'session') return c.json({ error: 'not available for chats' }, 400);

    type InviteBody = {
      invitedEmail?: string;
      role?: 'owner' | 'member' | 'guest';
      ttlDays?: number;
      /** ADR 0053 (amended): one link for everyone who should be in. Members only. */
      reusable?: boolean;
    };
    // An empty body is valid: it means "a default member invite".
    const body: InviteBody = await c.req.json<InviteBody>().catch(() => ({}));

    const { summary, token } = await createInvite(db, {
      sessionId: s.id,
      createdByUserId: c.get('user').id,
      // `guest` (M22): a viewer of this one session. Anything else unknown is a member.
      role: body.role === 'owner' ? 'owner' : body.role === 'guest' ? ('guest' as never) : 'member',
      invitedEmail: body.invitedEmail ?? null,
      ttlDays: body.ttlDays,
      reusable: body.reusable === true && body.role !== 'guest' && body.role !== 'owner' && !body.invitedEmail,
    });
    trail(c, { action: 'invite.created', sessionId: s.id, detail: { inviteId: summary.id, role: summary.role, reusable: summary.maxUses === null } });

    return c.json(
      { invite: summary, token, url: `${PUBLIC_URL}/invite/${token}` },
      201,
    );
  });

  sessionRoutes.post('/invites/:id/revoke', async (c) => {
    const s = await resolve(c);
    if (!s || s.role !== 'owner') return c.notFound();

    const revoked = await revokeInvite(db, { sessionId: s.id }, c.req.param('id'));
    if (!revoked) return c.notFound();
    trail(c, { action: 'invite.revoked', sessionId: s.id, detail: { inviteId: c.req.param('id') } });
    return c.json({ ok: true });
  });

  /**
   * The bridge socket — lane B.
   *
   * Authenticated with the same participant-scoped bearer token as the MCP
   * endpoint, sent as a header (possible because the bridge is a Node process, not
   * a browser). The server decides what to push; the bridge is a dumb pipe.
   * See ADR 0010 and docs/protocol.md.
   */
  app.get(
    '/bridge/o/:owner/s/:session',
    upgradeWebSocket((c) => {
      const ownerSlug = c.req.param('owner');
      const sessionPublicId = c.req.param('session');
      const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

      let unsubscribe: (() => void) | undefined;
      let unsubscribeAbort: (() => void) | undefined;
      let actorRef: { sessionId: string; participantId: string } | undefined;
      /**
       * `bridge` pushes into a live agent session; `runner` spawns a headless run.
       * Defaults to bridge so an older client keeps working, and is re-registered
       * when a `hello` frame declares otherwise.
       */
      let kind: 'bridge' | 'runner' = 'bridge';

      /**
       * Frames are handled ONE AT A TIME. Every handler below awaits the database,
       * so two frames arriving back to back would otherwise interleave and publish
       * out of order — "posted a reply" landing before the read it was based on.
       * An activity feed that reorders steps is worse than no feed at all.
       */
      let queue: Promise<void> = Promise.resolve();
      // M15 slice 1: the last sequence number accepted on this connection. A
      // numbered frame not above it is dropped, so a delayed frame cannot turn
      // idle back into working. Unnumbered frames (older bridges) pass.
      let lastSeq = -Infinity;

      const handleFrame = async (
        evt: { data: unknown },
        ws: { send: (data: string) => void },
      ): Promise<void> => {
        if (!actorRef) return;
        try {
          const frame = JSON.parse(String(evt.data)) as {
            type?: string;
            status?: string;
            kind?: string;
            runId?: string;
            provider?: string;
            messageId?: string;
            tool?: string;
            detail?: string | null;
            seq?: number;
            reason?: string;
            completed?: boolean;
          };
          if (typeof frame.seq === 'number' && frame.type !== 'hello') {
            if (!(frame.seq > lastSeq)) return;
            lastSeq = frame.seq;
          }

          /**
           * Run lifecycle and activity. Deliberately NOT routed through
           * deliverMentions or claimTurn: activity is display data, not a
           * delivery, and must neither reach another agent nor consume budget
           * (ADR 0015).
           */
          if (frame.type === 'run.start' && frame.runId) {
            await startRun(db, {
              runId: frame.runId,
              sessionId: actorRef.sessionId,
              participantId: actorRef.participantId,
              kind: frame.kind === 'channel' ? 'channel' : 'spawn',
              provider: frame.provider,
              triggerMessageId: frame.messageId,
            });
            return;
          }

          if (frame.type === 'activity' && frame.runId && frame.tool) {
            await recordActivity(db, {
              runId: frame.runId,
              sessionId: actorRef.sessionId,
              participantId: actorRef.participantId,
              tool: frame.tool,
              detail: frame.detail ?? null,
            });
            return;
          }

          if (frame.type === 'run.end' && frame.runId) {
            const status =
              frame.status === 'stopped' || frame.status === 'failed'
                ? frame.status
                : 'done';
            await endRun(db, {
              runId: frame.runId,
              sessionId: actorRef.sessionId,
              participantId: actorRef.participantId,
              status,
            });
            return;
          }

          // Declaring `runner` re-registers the listener under that kind, so a
          // live bridge elsewhere still wins the mention (ADR 0011).
          if (frame.type === 'hello') {
            if (frame.kind !== 'runner' && frame.kind !== 'bridge') return;
            if (frame.kind === kind) return;

            kind = frame.kind;
            unsubscribe?.();
            const sessionId = actorRef.sessionId;
            unsubscribe = listenForMentions(
              actorRef.participantId,
              kind,
              ({ message, trust }) => sendMention(ws, sessionId, message, trust),
            );
            await setConnectionStatus(db, { ...actorRef, kind, status: 'connected' });
            return;
          }

          if (frame.type !== 'status') return;
          if (
            frame.status !== 'working' &&
            frame.status !== 'blocked' &&
            frame.status !== 'idle' &&
            frame.status !== 'connected'
          ) {
            return;
          }
          // M15 slice 1: a blocked agent says why (an unknown reason is kept as "waiting"); an idle may say it completed work.
          const reason = typeof frame.reason === 'string' ? frame.reason.slice(0, 32) : null;
          const detail = typeof frame.detail === 'string' ? frame.detail.slice(0, 120) : null;
          await setConnectionStatus(db, { ...actorRef, kind, status: frame.status, reason, detail, completed: frame.completed === true });
        } catch {
          // Ignore a malformed frame rather than dropping the connection.
        }
          };

      return {
        async onOpen(_evt, ws) {
          // Refusals travel in-band: a close code issued during the upgrade
          // arrives as 1006 with no reason (see docs/protocol.md).
          const refuse = (code: 'unauthenticated' | 'not_found') => {
            ws.send(JSON.stringify({ type: 'error', code }));
            ws.close();
          };

          if (!bearer) return refuse('unauthenticated');
          if (!ownerSlug || !sessionPublicId) return refuse('not_found');

          const actor = await resolveSessionToken(db, bearer);
          if (
            !actor ||
            actor.sessionPublicId !== sessionPublicId ||
            actor.ownerSlug !== ownerSlug
          ) {
            return refuse('not_found');
          }
          // A channel push starts a turn, so only an agent may hold a bridge.
          if (actor.participantKind !== 'agent') return refuse('not_found');

          actorRef = { sessionId: actor.sessionId, participantId: actor.participantId };

          ws.send(
            JSON.stringify({
              type: 'ready',
              participant: {
                id: actor.participantId,
                display_name: actor.participantName,
              },
              session: { id: actor.sessionPublicId, owner: actor.ownerSlug },
            }),
          );

          // Warm the repo cache now, so the first mention is delivered synchronously.
          void linkedRepos(db, actor.sessionId).catch(() => {});
          unsubscribe = listenForMentions(
            actor.participantId,
            kind,
            ({ message, trust }) => sendMention(ws, actor.sessionId, message, trust),
          );

          // A pause asks connections to drop in-flight work. Cooperative by
          // necessity: the process is on the user's machine (ADR 0012).
          unsubscribeAbort = onAbort(actor.sessionId, () => {
            ws.send(JSON.stringify({ type: 'abort' }));
          });

          await setConnectionStatus(db, {
            sessionId: actor.sessionId,
            participantId: actor.participantId,
            kind,
            status: 'connected',
          });
        },

        onMessage(evt, ws) {
          // A caught chain keeps a single bad frame from stalling every later one.
          queue = queue.then(() => handleFrame(evt, ws)).catch(() => {});
          return queue;
        },

        async onClose() {
          unsubscribe?.();
          unsubscribeAbort?.();
          if (actorRef) {
            await setConnectionStatus(db, { ...actorRef, kind, status: 'offline' }).catch(
              () => {},
            );
          }
        },
        onError() {
          unsubscribe?.();
          unsubscribeAbort?.();
        },
      };
    }),
  );

  /**
   * Mint a run-scoped token.
   *
   * Same session, same participant, short TTL, one run. A runner cannot mint a
   * token for anyone else — the participant comes from its own credential, never
   * from the request. See ADR 0011.
   */
  app.post('/bridge/o/:owner/s/:session/run-token', async (c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearer) {
      return c.json({ error: 'unauthorized' }, 401, {
        'WWW-Authenticate': 'Bearer realm="fabrikka"',
      });
    }

    const actor = await resolveSessionToken(db, bearer);
    if (
      !actor ||
      actor.sessionPublicId !== c.req.param('session') ||
      actor.ownerSlug !== c.req.param('owner') ||
      actor.participantKind !== 'agent'
    ) {
      return c.notFound();
    }

    // ADR 0041: a gated room starts no new agent runs.
    if (writesGuarded()) {
      const scope = await roomScope(db, actor.sessionId);
      const refusal = scope && (await checkWrite({ userId: actor.agent?.ownerUserId ?? null, ...scope, action: 'agent-run' }));
      if (refusal) return c.json({ error: refusal.reason, url: refusal.url ?? null, gated: true }, 402);
    }

    const minted = await issueRunToken(db, {
      sessionId: actor.sessionId,
      participantId: actor.participantId,
      createdByUserId: actor.agent?.ownerUserId ?? '',
    });
    if (!minted) return c.notFound();

    return c.json(minted, 201);
  });

  /**
   * ADR 0054: a run reports its state, its resume command or its end, with its
   * own run token. Input, treated as untrusted: the token fixes the participant
   * and the session, the body may only name a run of theirs, sizes are capped,
   * unknown values are ignored and answered 202, sixty a minute per run.
   */
  app.post('/bridge/o/:owner/s/:session/report', async (c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearer) return c.json({ error: 'unauthorized' }, 401, { 'WWW-Authenticate': 'Bearer realm="fabrikka"' });
    const actor = await resolveSessionToken(db, bearer);
    if (!actor || actor.sessionPublicId !== c.req.param('session') || actor.ownerSlug !== c.req.param('owner') || actor.participantKind !== 'agent') return c.notFound();
    const raw = await c.req.text();
    if (raw.length > 16 * 1024) return c.json({ error: 'too large' }, 413);
    let body: { report?: unknown; runId?: unknown; status?: unknown; reason?: unknown; detail?: unknown; completed?: unknown; argv?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'not JSON' }, 400);
    }
    const runId = typeof body.runId === 'string' ? body.runId : '';
    if (!runId || !(await runBelongsTo(db, actor.sessionId, actor.participantId, runId))) return c.notFound();
    if (!rateLimit(`report:${runId}`, { max: 60, windowMs: 60_000 })) return c.json({ error: 'too many reports' }, 429);
    const ignored = (why: string) => c.json({ ok: false, ignored: why }, 202);

    if (body.report === 'state') {
      const status = body.status;
      if (status !== 'working' && status !== 'blocked' && status !== 'idle') return ignored('status');
      const reason = typeof body.reason === 'string' ? body.reason.slice(0, 32) : null;
      const detail = typeof body.detail === 'string' ? body.detail.slice(0, 120) : null;
      await setConnectionStatus(db, { sessionId: actor.sessionId, participantId: actor.participantId, kind: 'runner', status, reason, detail, completed: body.completed === true });
      return c.json({ ok: true }, 202);
    }
    if (body.report === 'resume') {
      const argv = validResumeArgv(body.argv);
      if (!argv) return ignored('argv');
      await storeResumeArgv(db, runId, argv);
      return c.json({ ok: true }, 202);
    }
    if (body.report === 'release') {
      const status = body.status === undefined ? 'done' : body.status;
      if (status !== 'done' && status !== 'failed' && status !== 'stopped') return ignored('status');
      await endRun(db, { runId, sessionId: actor.sessionId, participantId: actor.participantId, status });
      return c.json({ ok: true }, 202);
    }
    return ignored('report');
  });

  /**
   * Revoke a run token when the run ends.
   *
   * A runner may only revoke tokens for its OWN participant, so possessing a
   * runner credential does not let you cut another agent's access.
   */
  app.delete('/bridge/o/:owner/s/:session/run-token/:tokenId', async (c) => {
    const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (!bearer) return c.json({ error: 'unauthorized' }, 401);

    const actor = await resolveSessionToken(db, bearer);
    if (
      !actor ||
      actor.sessionPublicId !== c.req.param('session') ||
      actor.ownerSlug !== c.req.param('owner')
    ) {
      return c.notFound();
    }

    const done = await revokeOwnToken(db, {
      sessionId: actor.sessionId,
      participantId: actor.participantId,
      tokenId: c.req.param('tokenId'),
    });
    if (!done) return c.notFound();
    return c.json({ ok: true });
  });

  /**
   * The MCP endpoint — lane A. Its own auth (participant-scoped bearer tokens),
   * so it is mounted outside the cookie-authenticated web API entirely.
   * See docs/protocol.md and ADR 0009.
   */
  const mcp = createMcpApp({
    db,
    publicUrl: PUBLIC_URL,
    allowedHosts: allowedHostsFor(PUBLIC_URL, process.env.MCP_ALLOWED_HOSTS),
  });
  app.route('/', mcp.app);

  /*
   * IMPORTANT: this must be registered BEFORE app.route() mounts the session
   * sub-app below. That sub-app applies requireUser to everything under the
   * same prefix, so if it matched first an unauthenticated upgrade would get a
   * 401 HTTP response and never become a WebSocket at all — the client would
   * see an abnormal close with no reason and retry forever.
   */
  /* -------------------------------------------------------------------------- */
  /* Realtime                                                                   */
  /* -------------------------------------------------------------------------- */

  /**
   * Session event stream. Read-only: the browser posts over HTTP and receives the
   * resulting event back over this socket, so local echo and remote fan-out
   * follow the same path and cannot disagree.
   *
   * Authenticated by the same cookie as the REST API, and membership-checked —
   * a socket is not a way around the access rules.
   */
  /**
   * The local host socket (M31, ADR 0027). Authenticated with the device token.
   * The host reports its grants (labels, never paths); the server answers with the
   * agents bound to it, each with a fresh token. The host then opens an ordinary
   * runner connection per binding — so nothing here starts a run by itself.
   */
  app.get(
    '/host',
    upgradeWebSocket((c) => {
      const bearer = c.req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
      let deviceId: string | null = null;
      let me: { send: (d: string) => void; close: () => void } | null = null;
      /** Bindings (and their fresh tokens) go out once per connection, not per grant change. */
      let bound = false;
      /**
       * The host sends its grants the moment the socket opens, which can be before
       * the device lookup below resolves. Frames wait for it: one dropped here
       * meant no bindings for the whole connection, and every agent offline.
       */
      let opened: Promise<void> = Promise.resolve();
      return {
        onOpen(_evt, ws) {
          opened = (async () => {
            const device = await resolveDevice(db, bearer);
            if (!device) {
              ws.send(JSON.stringify({ type: 'error', code: 'unauthenticated' }));
              ws.close();
              return;
            }
            deviceId = device.id;
            me = { send: (d) => ws.send(d), close: () => ws.close() };
            hostHub.attach(device.id, me);
            ws.send(JSON.stringify({ type: 'ready', device: { id: device.id, name: device.name } }));
            // ADR 0043: the organizations its folders may be for, for the "For" picker.
            ws.send(JSON.stringify({ type: 'organizations', organizations: await organizationsOf(db, device.userId) }));
          })();
          // M33: the client this server serves, so an out-of-date host can say so.
          void opened.then(async () => {
            const release = deviceId ? await clientRelease() : null;
            if (release) ws.send(JSON.stringify({ type: 'client', version: release.version }));
          });
        },
        async onMessage(evt, ws) {
          await opened;
          if (!deviceId) return;
          let frame: { type?: string; grants?: { id: string; label: string; providers: string[]; org?: string | null }[] };
          try {
            frame = JSON.parse(String(evt.data));
          } catch {
            return;
          }
          if (frame.type === 'grants' && Array.isArray(frame.grants)) {
            await setGrants(db, deviceId, frame.grants);
            // ADR 0043: after an organization change, the bindings again, checked against the new scope.
            if (!bound || hostHub.takeRebind(deviceId)) {
              bound = true;
              ws.send(JSON.stringify({ type: 'bindings', bindings: await bindingsForDevice(db, deviceId, PUBLIC_URL) }));
            }
          }
        },
        // After the lookup, so a socket that closes mid-lookup isn't left attached.
        onClose() {
          void opened.then(() => deviceId && me && hostHub.detach(deviceId, me));
        },
        onError() {
          void opened.then(() => deviceId && me && hostHub.detach(deviceId, me));
        },
      };
    }),
  );

  /**
   * M42 (ADR 0037): one stream per person. Counts for every room they can see,
   * as they change, and a `notify` per new item. Login cookie only; it sends,
   * and never reads anything from the socket.
   */
  startAttention(db);
  app.get(
    '/api/me/stream',
    upgradeWebSocket((c) => {
      const token = readCookie(c);
      let stop: (() => void) | undefined;
      return {
        async onOpen(_evt, ws) {
          const user = await resolveToken(db, token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'stream.error', code: 'unauthenticated' }));
            ws.close();
            return;
          }
          stop = addStream(user.id, (event) => ws.send(JSON.stringify(event)));
        },
        onClose() {
          stop?.();
        },
        onError() {
          stop?.();
        },
      };
    }),
  );

  app.get(
    '/api/o/:owner/s/:session/stream',
    upgradeWebSocket((c) => {
      const ownerSlug = c.req.param('owner');
      const sessionPublicId = c.req.param('session');
      const token = readCookie(c);
      let unsubscribe: (() => void) | undefined;

      return {
        async onOpen(_evt, ws) {
          /**
           * Refuse with an in-band frame, then close. A close code issued this
           * early does not reliably reach the client (it arrives as 1006), so the
           * reason travels as a normal message instead. See docs/protocol.md.
           */
          const refuse = (code: 'unauthenticated' | 'not_found') => {
            ws.send(JSON.stringify({ type: 'stream.error', code }));
            ws.close();
          };

          if (!ownerSlug || !sessionPublicId) return refuse('not_found');

          const user = await resolveToken(db, token);
          if (!user) return refuse('unauthenticated');

          // Viewers (M22) may listen: this socket only sends, so it gives them
          // nothing to write with.
          const s = await resolveSessionForViewer(
            db,
            ownerSlug,
            sessionPublicId,
            user.id,
          );
          // Same answer for "no such session" and "not a member".
          if (!s) return refuse('not_found');

          // Catch-up: a late joiner should see the run in progress, not just a
          // spinner and then an answer.
          const { runs: liveRuns, activity } = await catchUp(db, s.id);

          ws.send(
            JSON.stringify({
              type: 'hello',
              sessionId: s.view.publicId,
              participants: await listParticipants(db, s.id),
              runs: liveRuns,
              activity,
            }),
          );

          unsubscribe = subscribe(s.id, (event) => ws.send(JSON.stringify(event)));
        },
        onClose() {
          unsubscribe?.();
        },
        onError() {
          unsubscribe?.();
        },
      };
    }),
  );


  /**
   * Output sync socket (M12). The standard Yjs sync and awareness protocols, so
   * humans co-edit in real time. Same cookie, same membership check and the same
   * in-band refusal as the session stream. Agents never use it: their edits come
   * over MCP and are applied server-side (ADR 0019).
   */
  app.get(
    '/api/o/:owner/s/:session/outputs/:output/sync',
    upgradeWebSocket((c) => {
      const ownerSlug = c.req.param('owner');
      const sessionPublicId = c.req.param('session');
      const outputId = c.req.param('output') ?? '';
      const token = readCookie(c);
      let handlers: Awaited<ReturnType<typeof attachSocket>> = null;
      let closed = false;
      // A client sends its first sync step the moment the socket opens, while we
      // are still checking who it is. Held, not dropped, or it never syncs.
      const early: (ArrayBuffer | string)[] = [];

      return {
        async onOpen(_evt, ws) {
          const refuse = (code: 'unauthenticated' | 'not_found') => {
            ws.send(JSON.stringify({ type: 'stream.error', code }));
            ws.close();
          };
          if (!ownerSlug || !sessionPublicId) return refuse('not_found');
          const user = await resolveToken(db, token);
          if (!user) return refuse('unauthenticated');
          const s = await resolveSessionForViewer(db, ownerSlug, sessionPublicId, user.id);
          if (!s) return refuse('not_found');

          handlers = await attachSocket(db, {
            sessionId: s.id,
            outputId,
            // A viewer (M22) syncs read-only: the store drops every update they send.
            participantId: s.participantId,
            readOnly: s.access === 'viewer',
            ws: {
              send: (data) => ws.send(data as never),
              close: () => ws.close(),
            },
          });
          if (!handlers) return refuse('not_found');
          for (const data of early.splice(0)) handlers.onMessage(data);
          // The socket may have closed while we were checking.
          if (closed) handlers.onClose();
        },
        onMessage(evt) {
          const data = evt.data as ArrayBuffer | string;
          if (handlers) handlers.onMessage(data);
          else if (early.length < 100) early.push(data);
        },
        onClose() {
          closed = true;
          handlers?.onClose();
        },
        onError() {
          closed = true;
          handlers?.onClose();
        },
      };
    }),
  );

  app.route('/api/o/:owner/s/:session', sessionRoutes);

  /**
   * Setup instructions for one agent, generated per provider.
   *
   * Only the lanes that actually work for that provider are offered. Channels are
   * Claude Code-specific and stdio-only, and spawning only knows how to launch
   * `claude` and `codex` — so a Codex agent must not be shown a channel setup, and
   * an unknown provider gets the plain MCP endpoint and nothing else.
   * See docs/protocol.md.
   */
  function agentSetup(mcpUrl: string, token: string, provider: string) {
    const bridgeMcpJson = JSON.stringify(
      {
        mcpServers: {
          fabrikka: {
            command: BRIDGE_COMMAND[0],
            args: [...BRIDGE_COMMAND.slice(1), 'connect'],
            env: { FABRIKKA_URL: mcpUrl, FABRIKKA_TOKEN: token },
          },
        },
      },
      null,
      2,
    );

    const runnerCommand =
      `FABRIKKA_URL=${mcpUrl} \\
  FABRIKKA_TOKEN=${token} \\
  ` +
      `${BRIDGE_COMMAND.join(' ')} watch --dir .` +
      // Every tool gets the default policy, `edit`: verified for Claude Code (ADR
      // 0027), with its read caveat for Codex (ADR 0032), and for OpenCode (ADR 0047).
      (provider === 'codex' || provider === 'opencode' || provider === 'antigravity' ? ` --provider ${provider}` : '');

    // Phrased for the provider's own CLI. Codex takes the token from the
    // environment because it rejects a literal `bearer_token`, which conveniently
    // keeps it out of config.toml. An unknown provider gets the endpoint and header
    // rather than a command for a client it may not be: telling someone to run
    // `claude mcp add` for a Cursor agent is worse than telling them nothing.
    const remoteCommand =
      provider === 'codex'
        ? `FABRIKKA_TOKEN=${token} \\
  codex mcp add fabrikka --url ${mcpUrl} \\
    --bearer-token-env-var FABRIKKA_TOKEN`
        : provider === 'claude-code'
          ? `claude mcp add --transport http fabrikka ${mcpUrl} --header "Authorization: Bearer ${token}"`
          : provider === 'opencode'
            ? `opencode mcp add fabrikka --url ${mcpUrl} --header "Authorization=Bearer ${token}"`
            : provider === 'antigravity'
              // ADR 0055: an http entry takes literal headers, so this is for one room; the host path uses `fabrikka connect` instead.
              ? `agy mcp add --header "Authorization: Bearer ${token}" fabrikka-session ${mcpUrl}`
              : `Streamable HTTP MCP endpoint:\n  ${mcpUrl}\n\nAuthorization: Bearer ${token}`;

    // ADR 0054: any command may act as this agent, Full policy only. The line runs as
    // pasted (the five-click rule): a sample command that answers with its run id;
    // the person replaces what comes after -- with their own.
    const commandCommand =
      `FABRIKKA_URL=${mcpUrl} \\
  FABRIKKA_TOKEN=${token} \\
  ` + `${BRIDGE_COMMAND.join(' ')} run --dir . -- sh -c 'cat >/dev/null; echo "hello from $FABRIKKA_RUN_ID"'`;

    const lanes: SetupLane[] =
      provider === 'claude-code'
        ? ['bridge', 'runner', 'remote', 'command']
        : provider === 'codex' || provider === 'opencode' || provider === 'antigravity'
          ? ['runner', 'remote', 'command']
          : ['remote', 'command'];

    return {
      token,
      mcpUrl,
      setup: {
        lanes,
        remoteCommand,
        bridgeMcpJson: lanes.includes('bridge') ? bridgeMcpJson : null,
        bridgeCommand: lanes.includes('bridge')
          ? 'claude --dangerously-load-development-channels server:fabrikka'
          : null,
        runnerCommand: lanes.includes('runner') ? runnerCommand : null,
        commandCommand,
      },
    };
  }

  /** Resolve the session addressed by the current route, for the current user. */
  /**
   * Deliver a mention to a bridge or runner, with the session's linked repos so a
   * spawned run's preamble can name them (M19). Chained per socket: the repo
   * lookup is async, and two mentions must still arrive in the order they fired.
   */
  const mentionQueues = new WeakMap<object, Promise<void>>();
  function sendMention(ws: { send: (data: string) => void }, sessionId: string, message: unknown, trust: unknown) {
    const frame = (repos: { url: string; title: string | null }[]) =>
      JSON.stringify({ type: 'mention', message, trust, ...(repos.length ? { repos } : {}) });
    // The common case is synchronous: repos cached, nothing queued ahead of us.
    const cached = cachedRepos(sessionId);
    if (cached && !mentionQueues.has(ws)) {
      ws.send(frame(cached));
      return;
    }
    const prev = mentionQueues.get(ws) ?? Promise.resolve();
    const next = prev
      .then(async () => ws.send(frame(await linkedRepos(db, sessionId).catch(() => []))))
      .catch(() => {})
      .finally(() => {
        if (mentionQueues.get(ws) === next) mentionQueues.delete(ws);
      });
    mentionQueues.set(ws, next);
  }

  /** Members, each marked with whether their access came from the team roster (M21). */
  async function membersWithOrigin(sessionId: string) {
    const origins = await membershipOrigins(db, sessionId);
    return (await listMembers(db, sessionId)).map((m) => ({ ...m, viaTeam: origins.has(m.userId) }));
  }

  /** The viewer-aware resolver (M22). Only allowlisted read routes may use it. */
  async function resolveViewer(c: {
    req: { param: (k: string) => string | undefined };
    get: (k: 'user') => AuthEnv['Variables']['user'];
  }) {
    const owner = c.req.param('owner');
    const session = c.req.param('session');
    if (!owner || !session) return null;
    return resolveSessionForViewer(db, owner, session, c.get('user').id);
  }

  async function resolve(c: {
    req: { param: (k: string) => string | undefined };
    get: (k: 'user') => AuthEnv['Variables']['user'];
  }) {
    const owner = c.req.param('owner');
    const session = c.req.param('session');
    if (!owner || !session) return null;
    return resolveSessionForUser(db, owner, session, c.get('user').id);
  }


  /**
   * Serve the built web app, when there is one.
   *
   * In development Vite serves the UI on :5173 and proxies /api here, so this does
   * nothing. In production — and for the desktop shell, which points at a single
   * URL — the server has to serve both, or the app is an API with no interface.
   *
   * Registered last so it never shadows /api, /mcp or /bridge.
   */
  const WEB_DIST = resolvePath(import.meta.dirname, '../../web/dist');

  if (existsSync(WEB_DIST)) {
    // ADR 0044: a build names its files by their content, so they never change.
    app.use(
      '/assets/*',
      compressText,
      async (c, next) => {
        await next();
        if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable');
      },
      serveStatic({ root: relative(process.cwd(), WEB_DIST) }),
    );
    // A file an old build named, or none did: a 404, not the page (and never cached for a year).
    app.get('/assets/*', (c) => c.notFound());
    // The icons, manifest, preview card and robots.txt at the site root
    // (brand/README.md; docs/operations.md, "Link previews and search engines").
    // Named one by one, so nothing else in the build becomes reachable by accident.
    for (const file of ['favicon.svg', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'site.webmanifest', 'og-image.png', 'robots.txt']) {
      app.get(`/${file}`, serveStatic({ root: relative(process.cwd(), WEB_DIST), path: file }));
    }

    // SPA fallback: every non-API path returns index.html so client-side routes
    // like /o/fede/s/demo work on a hard refresh.
    // ADR 0044: checked on every load, so a deploy shows at once; a 304 when unchanged.
    app.get('*', compressText, validate, async (c) => {
      if (c.req.path.startsWith('/api') || c.req.path.startsWith('/mcp') || c.req.path.startsWith('/themes/')) {
        return c.notFound();
      }
      const html = await readFile(resolvePath(WEB_DIST, 'index.html'), 'utf8');
      c.header('cache-control', 'no-cache');
      // The preview image and canonical address name this instance, not "/".
      return c.html(withPublicUrl(html, PUBLIC_URL));
    });

    console.log(`serving the web app from ${WEB_DIST}`);
  } else {
    console.log('no web build found — run `pnpm --filter @fabrikka/web build` to serve the UI');
  }

  return {
    app,
    /**
     * Bring the database up to date, say how to set up a fresh instance, then
     * listen on PORT with the sockets attached (M39: nobody migrates by hand).
     */
    async start(port = PORT) {
      await runMigrations(db);
      await setup.prepare();
      // M43: call records expire. Once now, then daily; never keeps the process alive.
      const prune = () =>
        pruneTeamCalls(db)
          .then((n) => n && console.log(`[call records] deleted ${n} past their team's setting`))
          .catch((err) => console.warn(`[call records] cleanup failed: ${(err as Error).message}`));
      void prune();
      setInterval(prune, 24 * 60 * 60 * 1000).unref();
      // M58 (ADR 0057): deletions past their grace period. Once now, then daily.
      const leave = () =>
        runDueDeletions(db)
          .then((n) => n && console.log(`[leaving] deleted ${n} account${n === 1 ? '' : 's'} past the grace period`))
          .catch((err) => console.warn(`[leaving] due deletions failed: ${(err as Error).message}`));
      void leave();
      setInterval(leave, 24 * 60 * 60 * 1000).unref();
      // M60 (ADR 0058): the trail past its retention. Once now, then daily.
      const trim = () =>
        pruneAudit(db)
          .then((n) => n && console.log(`[trail] deleted ${n} event${n === 1 ? '' : 's'} past retention`))
          .catch((err) => console.warn(`[trail] prune failed: ${(err as Error).message}`));
      void trim();
      setInterval(trim, 24 * 60 * 60 * 1000).unref();
      // M61: a backup a day into FABRIKKA_BACKUP_DIR, sealed with FABRIKKA_BACKUP_KEY,
      // a minute after start and then daily; older archives pruned past BACKUP_KEEP_DAYS.
      const backupDir = process.env.FABRIKKA_BACKUP_DIR;
      const backupKey = process.env.FABRIKKA_BACKUP_KEY;
      if (backupDir && backupKey) {
        const save = () =>
          createBackup({ databaseUrl: process.env.DATABASE_URL!, artifactDir: STORAGE_DIR, passphrase: backupKey, dir: backupDir, publicUrl: PUBLIC_URL })
            .then(async (r) => {
              const pruned = await pruneBackups(backupDir, BACKUP_KEEP_DAYS);
              console.log(`[backup] wrote ${r.file} (${(r.bytes / 1024 / 1024).toFixed(1)} MB)${pruned ? `, pruned ${pruned} older` : ''}`);
              await audit(db, { action: 'admin.backup', actorKind: 'system', detail: { bytes: r.bytes, artifacts: r.manifest.artifacts.count, scheduled: true } });
            })
            .catch((err) => console.warn(`[backup] failed: ${(err as Error).message}`));
        setTimeout(save, 60_000).unref();
        setInterval(save, 24 * 60 * 60 * 1000).unref();
      } else if (backupDir) {
        console.warn('[backup] FABRIKKA_BACKUP_DIR is set but FABRIKKA_BACKUP_KEY is not: no backups will be written (docs/operations.md, "Backups")');
      }
      // M63: what organizations chose not to keep. Once now, then daily.
      const keep = () =>
        pruneRetention(db)
          .then((p) => {
            const line = summarizeRetention(p);
            if (line) console.log(`[retention] deleted ${line}`);
          })
          .catch((err) => console.warn(`[retention] prune failed: ${(err as Error).message}`));
      void keep();
      setInterval(keep, 24 * 60 * 60 * 1000).unref();
      return new Promise<ReturnType<typeof serve>>((resolveStart) => {
        const server = serve({ fetch: app.fetch, port }, (info) => {
          console.log(`fabrikka server on http://localhost:${info.port}`);
          console.log(`[rate limits] ${clientIpHeader ? `client address read from the platform's ${clientIpHeader} header (FABRIKKA_CLIENT_IP_HEADER)` : trustedProxies ? `client address read behind ${trustedProxies} proxy(ies) (FABRIKKA_TRUSTED_PROXIES)` : 'client address is the socket (no FABRIKKA_TRUSTED_PROXIES)'}`);
          resolveStart(server);
        });
        injectWebSocket(server);
      });
    },
  };
}
