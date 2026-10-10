# 0033 — In the desktop app, a vendor sign-in runs in the default browser, through a one-time handoff

**Status:** Proposed
**Date:** 2026-10-10
**Builds on:** [ADR 0024](0024-connections-are-categories-over-vendor-mcp-servers.md) (connecting a vendor
over OAuth, M18) and [ADR 0031](0031-the-desktop-app-runs-the-local-host.md) (the
desktop app).

## Context

The desktop app opens links to other sites in the person's default browser
(docs/security.md, "The desktop app"). Connecting a vendor was the exception: the
web app sends its own window to the vendor's sign-in page, and the vendor sends
it back to `/api/connections/oauth/callback`. That callback finishes the
connection only for the signed-in user who started it, so it needs Fabrikka's
login cookie. The app's window has that cookie. The default browser may not
have it at all.

People expect a sign-in to a vendor to open in their own browser, where they're
already signed in to Atlassian or GitHub, where their password manager works,
and where the address bar shows whose page it is. That's what desktop apps do.

The browser can't simply be trusted to finish the flow on the strength of the
`state` alone. Whoever holds a sign-in URL could forward it to someone else, and
if that person consents, *their* vendor account is attached to the *sender's*
Fabrikka account: the classic OAuth login-CSRF, turned around. Today the login
cookie is what stops this.

## Decision

**In the desktop app, connecting a vendor goes through a one-time handoff link,
opened in the default browser. The link names the Fabrikka account it connects
to, and a cookie binds the browser that followed it to that one sign-in.**

1. **Start, in the app.** The signed-in app asks to start with `handoff: true`.
   The server checks the vendor and its fields as usual, then returns a
   **handoff URL** on the instance's own origin:
   `/api/connections/oauth/handoff?t=<ticket>`. The ticket is sealed with the
   instance's encryption key (AES-256-GCM, so it can't be forged or edited). It
   carries the user, the vendor and its fields, and it **expires after 5
   minutes**.
2. **The app hands the URL to the browser.** The web app navigates to the
   handoff URL. The desktop app cancels that navigation in its own window and
   opens the URL in the default browser. This is a rule in Rust about that one
   path on the configured instance's origin. The remote page gets no new IPC
   command.
3. **The browser confirms the account.** The handoff page says *Connect Jira to
   Fabrikka as fede@example.com* and has one **Continue** button. Its `GET` does
   nothing, so a link previewer can't start a flow.
4. **Continue (a `POST`)** starts the ordinary flow for the ticket's user, sets a
   short-lived cookie holding that flow's `state` (HttpOnly, `SameSite=Lax`,
   `Path=/api/connections/oauth/callback`, 10 minutes, `Secure` over HTTPS), and
   redirects to the vendor.
5. **The callback** accepts the flow if **either** the login cookie names the
   flow's user (today's path) **or** the handoff cookie equals the `state` the
   vendor sent back. The flow is still single-use and unexpired, as today. A
   handoff callback ends on a small page in the browser that says the vendor is
   connected and the person can return to the app. It clears the cookie.
6. **Back in the app**, Personal integrations says *Finish signing in in your
   browser*. It reloads its list when the window regains focus.

In a browser (not the app), nothing changes: the flow runs in the same tab,
under the login cookie.

Clicks, from Personal integrations: **Connect** (1) → the browser opens → 
**Continue** (2) → the vendor's own consent (3). That's within the five-click rule,
with nothing to paste.

## Consequences

- **A forwarded handoff link is the residual risk.** Someone who got a person's
  handoff link within its 5 minutes could connect *their* vendor account to that
  person's Fabrikka account. Three things narrow this: the ticket exists only
  in the app's own navigation and the browser's history; the handoff page names
  the account it connects to; and the vendor's consent screen comes after that.
  The ticket isn't single-use. Making it so needs a table, and the flow it
  starts already is.
- **A ticket in a URL.** `docs/security.md` keeps session tokens out of URLs. A
  handoff ticket isn't a session token: it can only start a sign-in for one
  vendor, it can't read anything, and it expires in minutes. It's recorded there
  as a deliberate exception.
- **Older desktop apps keep working.** Without the Rust rule, the handoff page
  opens in the app's own window, and the cookie binding works there too.
- **No schema change.** The ticket is sealed, not stored. The flow table is
  unchanged.

## Alternatives considered

- **Sign in to Fabrikka in the browser first.** No new trust path, but a second
  login per browser, and the browser stays signed in afterwards. Rejected by the
  owner in favour of the handoff.
- **Trust `state` alone at the callback.** It's exactly the login-CSRF described
  above.
- **A new IPC command, `open_in_browser(url)`, for the remote page.** It would
  hand a compromised server a way to open arbitrary pages on the person's
  machine. A Rust rule about one fixed path on the instance's origin gives it
  nothing to name.
- **Open the handoff with `window.open` after the start request.** WebKit drops a
  pop-up that isn't in direct response to a click, and the request's `await`
  breaks that link.
