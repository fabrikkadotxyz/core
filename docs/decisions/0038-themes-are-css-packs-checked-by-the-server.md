# 0038 — Themes are CSS packs: tokens are the contract, the server checks them

**Status:** Proposed
**Date:** 2026-10-10
**Builds on:** [ADR 0029](0029-the-core-is-a-library-a-deployment-extends-it.md)
(a deployment adds to the core), [ADR 0034](0034-license-agpl-3.0.md) (anyone
may modify and share Fabrikka), and the gradient look (2026-10-08).

## Context

People spend hours in a room, and want it to look the way they work: a
developer may want a terminal, a student a page, an office worker something
calm. Today the look is one stylesheet. The dark palette exists but nobody can
choose it.

The owner also wants **other people to make themes and share them**, the way
editors and terminals have theme ecosystems. That makes a theme an interface
Fabrikka doesn't control, like the protocol: once people write themes against
it, renaming what they target breaks them. So the format has to be decided
before the first theme ships, and the built-in themes have to use it too, or
it's never tested.

A theme also runs in every person's page, next to their rooms and their
integrations. Whatever a theme can do, a bad theme can do.

## Decision

**A theme is a folder: a `theme.json` manifest, a `theme.css` stylesheet, and
optionally its fonts and images. It contains no code. Its stable interface is a
documented list of CSS custom properties (tokens). The server checks every theme
when it starts and refuses one that could fetch from elsewhere. Each person picks
their theme, and the choice follows their account.**

### The pack

```
themes/terminal/
  theme.json   { "contract": 1, "id": "terminal", "name": "Terminal",
                 "description": "…", "author": "…", "license": "…",
                 "scheme": "dark", "swatches": ["#13121a", "#b9a6f0", …] }
  theme.css
  fonts/…      (optional: woff2, woff)
  images/…     (optional: png, jpg, webp)
```

- **`contract` is the token contract version** (`docs/themes.md`). Fabrikka
  offers a theme only if it supports that version.
- **`scheme` (`light` or `dark`)** sets the browser's `color-scheme`, so
  scrollbars and form controls follow, and the *Match my system* choice knows
  which themes fit.
- **`swatches`** (up to 6 hex colours) draw the theme's card in the picker
  without loading it.

### Tokens are the contract; class names are not

- **The supported interface is the token list** in `docs/themes.md`: colours,
  surfaces, gradients, shadows, radii, fonts and heading style. Removing or
  renaming one is a breaking change: a new contract version, with the old one
  supported for a release.
- **A theme may also target the app's class names** to change more than tokens
  allow. Those selectors are **not** a contract. They can change in any release.
  Built-in themes are kept working, and others may break.
- **Only the chosen theme's CSS is loaded,** after the app's own, so a theme's
  rules can be plain `:root { … }` without scoping.

### What a theme may not do, checked by the server

At start, the server reads its built-in themes and the instance's theme
directory, and **skips with a logged reason** any pack that:

- has an invalid manifest, or an `id` that isn't 1–40 of `a-z 0-9 -`, or
  clashes with an earlier theme's `id`;
- has CSS over 256 KB, or a font or image over 2 MB;
- has `@import`, or any `url()` that isn't a relative path inside its own folder.
  **No theme fetches from another origin,** so none can track who opens which
  page, or leak what a page shows through requests a selector triggers;
- has `expression(`, `javascript:`, `-moz-binding`, `behavior:` or
  `image-set(` (which takes a bare string as a URL);
- has a backslash anywhere: CSS escapes can spell `url(` or `@import` without
  their letters;
- ships any file that isn't CSS, JSON, woff, woff2, png, jpg or webp. **No SVG**:
  opened directly from the instance's origin, an SVG can run script.

A theme's files are served from `/themes/<id>/` with `X-Content-Type-Options:
nosniff` and the type fixed by extension.

### Where themes come from

- **Built-in:** `themes/` in the repository, shipped in the image. **Dusk** (the
  default, today's look), **Dusk Night** (today's dark palette), and four new
  ones that differ in more than colour: **Terminal**, **Paper**, **Brutal** and
  **Aurora**.
- **Amended 2026-10-13 (the owner's decision):** a seventh built-in,
  **Fabrikka** (the look of fabrikka.xyz), is now **the default**: what an
  account that hasn't chosen sees, and what the sign-in page shows. Dusk stays
  the app's own stylesheet, the base every theme's tokens fall back to, and is
  chosen explicitly like any other theme. *Match my system* is unchanged
  (Dusk, Dusk Night).
- **The instance's own:** `FABRIKKA_THEMES_DIR`, `/data/themes` in the Docker
  image. The operator adds a theme by putting its folder there and restarting.
  The operator chooses which themes exist, and people choose among them.
- **Sharing one** is sharing the folder: a Git repository, a zip. There's no
  marketplace and no install-from-URL in this ADR.

### Choosing

- **Settings → Appearance** shows each theme as a card drawn from its swatches.
  **One click applies it**, for that person, on every device: `users.theme`.
  From anywhere, that's 2 clicks.
- ***Match my system*** follows the operating system: Dusk in light mode, Dusk
  Night in dark mode.
- **The page paints in the right theme before it loads.** The choice is cached
  on the device, and a tiny inline script in `index.html` sets it before the
  app's script runs.
- **A theme the instance no longer offers** falls back to Dusk, quietly.

## Consequences

- **Theme authors get a documented, versioned surface,** and the six built-ins
  prove it covers very different looks.
- **The app's own CSS must use the tokens,** not literal colours, wherever a
  theme should reach. The gradient look's hard-coded values become tokens, and
  the dark palette moves out of `styles.css` into the *Dusk Night* pack.
- **A theme can make the interface misleading** (hide a warning, recolour a
  trust label). It can't read data or make requests, but it's trusted like the
  operator's own changes. That's why the operator installs themes and people
  only choose among them. `docs/security.md` says this.
- **New column** `users.theme`, nullable (`docs/data-model.md`).
- **A theme can't change layout behaviour** that lives in code: the sidebar's
  width, which panes exist, keyboard handling. That's deliberate: themes restyle,
  extensions (ADR 0029) add.

## Alternatives considered

- **Themes as JavaScript plugins.** They could do anything, including read every
  room. A look doesn't need code.
- **Only a set of colour tokens, no CSS.** Safe and simple, but every theme
  would be Dusk in other colours. The terminal theme needs a monospace font,
  square boxes and titles set into borders, which colours can't express.
- **Install a theme from a URL, per person.** Every person becomes an operator
  of code-like content in their own page, and the instance can't vouch for any
  of it. Possible later, behind the same server checks.
- **Scoped theme CSS (`:root[data-theme=x]`), all loaded at once.** It lets a
  switch skip a request, but every theme's CSS lands in every page, and one
  badly scoped rule restyles everybody's theme.
