# 0044 — A reload paints from what the tab last showed

**Status:** Proposed
**Date:** 2026-10-13
**Builds on:** [ADR 0038](0038-themes-are-css-packs-checked-by-the-server.md)
(theme packs, served by the instance).

## Context

Reloading the web app redraws everything from nothing, one step after another:

1. The server sends the app (about 390 KB of script, 46 KB of CSS) and the
   theme's fonts **uncompressed and uncacheable**: no `Cache-Control` and no
   validator on the app's files, `no-cache` without a validator on a theme's.
   The browser downloads all of it again on every reload.
2. Then the app waits, one request at a time: who you are (`/api/auth/me`),
   whether you've seen the welcome (`/api/me/onboarding`), then your
   organizations and then your rooms. It shows *Loading…* until each one
   answers, and an empty sidebar until the last one does. Opening the shell
   asked for the lists twice.
3. A room shows *Loading…* until its details arrive, then its messages.

On a hosted instance each step is a round trip, so a reload flashes a blank
page, a fallback font, an empty sidebar and an empty room before it settles.

## Decision

### The server lets the browser keep what doesn't change

- **The app's built files** (`/assets/*`, named by their content's hash) are
  sent with `Cache-Control: public, max-age=31536000, immutable`. A new
  build has new names, so a long life is safe.
- **`index.html`** (every page's entry) is `no-cache` with an `ETag`: always
  checked, so a deploy takes effect at once, and a 304 when nothing changed.
- **A theme's files** get an `ETag`. `theme.css` stays `no-cache`, so a changed
  theme shows on the next reload. Fonts and images may be kept for a day
  (`max-age=86400`) without asking. A theme author who replaces a font renames
  the file (`docs/themes.md`).
- **Text is compressed** (gzip) when the browser accepts it: the app's
  script and CSS, `index.html`, theme CSS, and the API's JSON. Server-sent
  events and WebSockets are untouched. `/mcp` and the bridge's endpoints are
  left as they are: their clients are agents, and their messages are small.

### The tab keeps a copy of what it last showed

The web app keeps a copy in the tab's `sessionStorage` of four things:

- who you are;
- whether you've seen the welcome;
- your organizations and rooms (the sidebar);
- the last room you opened: its details and its latest 100 messages.

On a reload it paints from that copy at once, then asks the server and
replaces it. The server is still the only authority. The copy decides what's
drawn for a moment, never what's allowed: every action goes to the server,
which checks it as before. If `/api/auth/me` says you're signed out, the copy
is dropped and you go to sign-in.

**Why `sessionStorage`, not `localStorage`:** what was asked for is a fast
*reload*, and `sessionStorage` lives exactly as long as the tab. A closed tab
leaves nothing behind. Room titles and messages don't sit on a shared
computer after you close the tab. A new tab still starts cold; that's the
price.

**Signing out clears it**, as does any 401 from `/api/auth/me`.

### And it asks once

The shell asks for its lists once when it opens, not twice.

## Consequences

- A reload of a room on a hosted instance paints the sidebar and the room's
  messages from the first frame. After the first visit it downloads only
  `index.html` (a 304) and the API's answers.
- For a moment after a reload, the screen can show what was true when you
  last looked: a room renamed elsewhere, a message deleted. The answers
  replace it within a round trip.
- A tab holds a copy of up to 100 messages of one room until it's closed.
  `docs/security.md` says so.
- A theme's font can be up to a day stale in a browser after it's replaced
  under the same name.
