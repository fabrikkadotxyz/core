/**
 * M32 fixture: a deployment built on the core library — `createApp` plus one
 * extension — the way a deployment's own program is. Used only by
 * scripts/acceptance/m32.mjs, on its own port.
 *
 * The extension is deliberately naive (an open account route with no checks):
 * it exists to prove what the KIT allows, not to be a sign-up.
 */
// By path: the repo root doesn't link workspace packages. Same entry file as
// the package export, so this is exactly what a deployment imports.
import { createApp, type Extension } from '../../apps/server/src/lib.ts';

const fixture: Extension = {
  name: 'fixture',
  mount(app, kit) {
    kit.advertise({ signupUrl: '/fixture-signup' });
    app.get('/api/fixture/ping', (c) => c.json({ ok: true, canSendEmail: kit.canSendEmail }));
    app.post('/api/fixture/accounts', async (c) => {
      const body = await c.req.json();
      const made = await kit.createAccountWithOwnTeam({ ...body, emailVerified: true });
      if (!made.ok) return c.json({ error: made.error }, 409);
      await kit.signIn(c, made.user.id);
      return c.json(made, 201);
    });
  },
};

await createApp({ extensions: [fixture] }).start(Number(process.env.PORT));
