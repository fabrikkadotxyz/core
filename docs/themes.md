# Themes

How Fabrikka's look is chosen, and how to make a theme others can use.
[ADR 0038](decisions/0038-themes-are-css-packs-checked-by-the-server.md) says
why it works this way.

**For theme authors, this page is the contract.** The token list below is
versioned. Class names in the app are not part of it.

## Choosing one

**Settings → Appearance** (the sidebar's *Appearance*, at the bottom), then a
theme's card: **2 clicks** from anywhere. The choice belongs to your account, so
it follows you to every browser and the desktop app. *Match my system* uses
Dusk in light mode and Dusk Night in dark mode.

| Theme | Scheme | What it's like |
| --- | --- | --- |
| **Dusk** (default) | light | The palette as gradients: soft cards, a dark sidebar, a banner for each page's title |
| **Dusk Night** | dark | The same palette, dark |
| **Terminal** | dark | A terminal multiplexer: monospace everywhere, square boxes with titles set into their borders, lavender on near-black |
| **Paper** | light | An editorial page: cream paper, serif type, ink-red accents, hairline rules, no shadows |
| **Brutal** | light | Thick black borders, hard offset shadows, flat primary colours, uppercase headings |
| **Aurora** | dark | Frosted glass on a night sky of teal, violet and pink light; rounded, glowing |

## A theme is a folder

```
my-theme/
  theme.json
  theme.css
  fonts/      optional: .woff2, .woff
  images/     optional: .png, .jpg, .webp
```

### `theme.json`

```json
{
  "contract": 1,
  "id": "my-theme",
  "name": "My theme",
  "description": "One sentence: what it looks like.",
  "author": "Your name",
  "license": "CC0-1.0",
  "scheme": "dark",
  "swatches": ["#13121a", "#1b1a24", "#b9a6f0", "#a6e3a1", "#e08a62"]
}
```

| Field | Rule |
| --- | --- |
| `contract` | `1`, the token contract below |
| `id` | 1–40 characters of `a-z`, `0-9` and `-`. Unique on the instance |
| `name` | Up to 40 characters |
| `description` | Up to 200 characters |
| `author`, `license` | Optional. Up to 100 characters each |
| `scheme` | `light` or `dark`. It sets the browser's `color-scheme` |
| `swatches` | 2–6 hex colours: background, panel, accent, then any. The picker draws the card from them |

### `theme.css`

Loaded **after** the app's own stylesheet, and only while the theme is chosen.
So a theme is usually one `:root { … }` block of tokens, then a few rules:

```css
:root {
  --bg: #13121a;
  --text: #cfcde0;
  --accent: #b9a6f0;
  --font-ui: "JetBrains Mono", ui-monospace, monospace;
  --radius: 0;
}
```

To use your own font, ship it in `fonts/` and point at it with a relative URL:

```css
@font-face { font-family: "My Font"; src: url("fonts/my-font.woff2") format("woff2"); }
```

### What the server refuses

The server checks every theme when it starts, and **skips** one that breaks a
rule, logging why. A theme may not:

- use `@import`, or a `url()` that isn't a relative path inside its own folder.
  Nothing loads from another site;
- contain `expression(`, `javascript:`, `-moz-binding`, `behavior:` or
  `image-set(`;
- contain a backslash. CSS escapes can spell `url(` without its letters, so
  write characters themselves: `content: '—'`, not `content: '\2014'`;
- be over 256 KB of CSS, or ship a font or image over 2 MB;
- ship any other kind of file. **No SVG**, because an SVG opened from the
  instance can run script.

## Installing one on an instance

Put the folder in the instance's theme directory, then restart:

- **Docker** (M39, Render, Railway): `/data/themes/<id>/`.
- **From a checkout:** `FABRIKKA_THEMES_DIR`, any directory.

The server log lists each theme it offers, and each it skipped and why. A theme
installed this way is offered to everyone on the instance, after the built-in
ones. **Install only themes you'd trust to change what your people see:** a
theme can't read anything or make requests, but it could hide or relabel a
warning.

## The tokens (contract 1)

Every token has a value in the default theme (Dusk, in
`apps/web/src/styles.css`), so a theme sets only what it changes.

### Colour

| Token | Used for |
| --- | --- |
| `--bg`, `--bg-sunken` | The page; recessed areas (wells, empty states) |
| `--panel`, `--panel-tint` | Cards and panes; a tinted panel |
| `--border` | Lines between things |
| `--text`, `--muted` | Body text; secondary text |
| `--accent`, `--on-accent` | The main action colour; text on it |
| `--attention` | Unread, needs-you |
| `--hover`, `--selected` | Row hover and selection washes |
| `--agent`, `--agent-border` | An agent's message |
| `--ok`, `--ok-soft`, `--ok-border` | Success: text, fill, border |
| `--warn`, `--warn-soft`, `--warn-border` | Caution |
| `--danger`, `--danger-soft`, `--danger-border` | Errors and destructive actions |
| `--author` | A message author's name |

### The sidebar

| Token | Used for |
| --- | --- |
| `--side-bg` | Its flat colour (`--grad-side` paints over it) |
| `--side-text`, `--side-strong`, `--side-muted` | Item text, emphasised text, headings |
| `--side-hover`, `--side-selected`, `--side-border` | Hover, selection, dividers |
| `--grad-side` | Its background |
| `--grad-side-on`, `--side-on-text`, `--side-on-meta`, `--side-on-shadow` | The selected item |
| `--side-field` | Inputs and the team switcher inside it |
| `--side-shadow` | Its edge shadow |

### Surfaces

| Token | Used for |
| --- | --- |
| `--app-bg` | The page background (may be layered gradients) |
| `--grad-panel` | Cards, messages, list rows |
| `--grad-agent` | An agent's message background |
| `--grad-tint` | Badges, the active option in a list |
| `--surface-border` | The border of cards and messages |
| `--field-bg` | Inputs, selects, the search box |
| `--focus-border`, `--focus-ring` | A focused field (`--focus-ring` is a `box-shadow`) |
| `--bar-bg`, `--bar-blur` | A room's header and the top bar (`--bar-blur` is a `backdrop-filter`) |
| `--composer-bg` | The message box's bar |
| `--rail-bg` | The side panes of a room |
| `--frame` | The gradient border of the catch-up card |
| `--stripe` | The coloured edge of a session row |
| `--hover-border`, `--lift` | A hovered card's border, and how far it rises (`-1px`, or `0`) |
| `--badge-bg`, `--badge-text`, `--badge-ok-bg`, `--badge-shared-bg` | Badges |
| `--vendor-bg` | Behind a vendor's logo |
| `--team-initial` | A team's initial in the switcher |

### Accent, shadows, shape

| Token | Used for |
| --- | --- |
| `--grad-accent`, `--grad-accent-hover` | Buttons, the selected chip, avatars |
| `--grad-attention` | The unread dot |
| `--shadow-soft`, `--shadow-lift`, `--shadow-accent`, `--shadow-msg` | Resting cards, hovered cards, buttons, messages |
| `--radius` | Cards, messages, lists |
| `--radius-control` | Buttons and fields |
| `--radius-card` | Large cards (sign-in, setup) |
| `--radius-pill` | Badges and chips |
| `--border-width` | Card, field and chip borders |

### Type and titles

| Token | Used for |
| --- | --- |
| `--font-ui`, `--font-mono`, `--font-heading` | Everything; code and activity; headings |
| `--heading-weight`, `--heading-tracking`, `--heading-case` | Headings' weight, letter-spacing and `text-transform` |
| `--banner-bg`, `--banner-text`, `--banner-shadow`, `--banner-radius`, `--banner-ring` | A page's title banner, and the ring drawn in its corner |
| `--title-ink` | The gradient that fills a card's heading (sign-in, setup) |

Plus `color-scheme`, which a theme should set to match its `scheme`.

## Going further than tokens

A theme may target the app's class names (`.msg`, `.side-item`, `.column > h1`,
…) for what tokens can't say: Terminal sets titles into borders, Brutal adds
hard shadows. **Those selectors aren't a contract.** They may change in any
release. Fabrikka keeps its built-in themes working, and others may need an
update. If you need something often, ask for a token.

## Changing the contract

Adding a token is backward compatible. Removing or renaming one, or changing
what it paints, is a new contract version. The old one stays supported for at
least one release, and this page keeps both lists until it goes.
