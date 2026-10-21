# Fabrikka's mark

A factory made of three puzzle pieces: separate parts, one plant. People and
their agents, each bringing a piece, producing something together.

| File | Use |
| --- | --- |
| `fabrikka-mark.svg` | The mark. One colour (`currentColor`), transparent, square. Use it anywhere at 48 px and up. |
| `favicon.svg` | The mark for small sizes: wider cuts so the puzzle joints survive at 16–32 px. Jet Black, Light Cyan in dark mode. |
| `app-icon.svg` | The app tile: the mark in Light Cyan on a Dusk Blue to Jet Black gradient, rounded. The desktop app, touch and install icons. |
| `app-icon-1024.png` | The tile rendered at 1024 px, for stores and press. |
| `social-card.svg` | The card a pasted link shows (Slack, X, LinkedIn, a search result): the mark, the name and the line on the tile's gradient, 2:1. |
| `social-preview.png` | The card at 1280×640, for the GitHub repository's *Social preview* (Settings → General). GitHub can't read it from the repository; the owner uploads it once. |
| `architecture.svg` | How Fabrikka works in one picture: a session, the people in it, the agents they bring (lane A and lane B), and the vendor tools reached as each person. For talks, posts and the docs; `architecture.png` is its 1600×1000 render. Keep it true to `ARCHITECTURE.md`. |
| `architecture-simple.svg` | The same in one breath: four boxes, three arrows. For a slide, a tweet, the top of a post; `architecture-simple.png` is its 1600×900 render. |
| `demo-pro-startup.gif` | The product in 25 seconds, for the top of the README: a team signs in, opens its factory, mentions an agent. 1200×634, 10 fps. |
| `demo-join-by-link.gif` | Joining from a session link: account, agents, a look, and in. Same format. |
| `demo-one-off-invite.gif` | Starting a one-off session from the home screen and copying its link. Same format; the capture carried a white strip at the bottom, cropped away with `ffmpeg -vf crop=1200:634:0:0` and a regenerated palette. |
| `setup-1-connect.png` | The landing's *Set up in three steps*, step 1: Settings → Your devices, the one-line install and a paired computer. Captured at 1× from the app with `PUBLIC_URL=https://app.fabrikka.xyz`, demo account Daniel Levy. 740×412. |
| `setup-2-room-agent.png` | Step 2: a room's Setup → Agents, *Add my agent* and the agent already in. 880×470. |
| `setup-3-invite-link.png` | Step 3: the home's one-off card, *… is ready*, with the link and Copy. 680×140. |
| `setup-get-started.png` | The app's own *Get started* card, the same steps as the landing's, for a before/after or a hero. 664×380. |

In the web app the mark is a component, `apps/web/src/components/Mark.tsx`,
the same shape and cuts. With `assemble`, the three pieces arrive from apart
and join, once, when the mark appears (the sign-in page): separate parts, one
plant. What lands is exactly the mark; people who asked for reduced motion see
it already assembled.

Generated from these, and committed:

- `apps/web/public/favicon.svg`, `favicon.ico` (16, 32 and 48 px);
- `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png` and
  `site.webmanifest`;
- `apps/web/public/og-image.png` (1200×600), the card every instance serves
  for link previews (`docs/operations.md`, *Link previews and search engines*);
- `apps/desktop/src-tauri/icons/icon.png` (the app, 512 px) and `icon.ico`
  (Windows, 16 to 256 px; Tauri won't build there without it);
- `icons/tray.png` (the menu bar, a 44 px black template that macOS tints).

To regenerate them after changing a source, from the repository root:

```bash
for n in 16 32 48; do rsvg-convert -w $n -h $n brand/favicon.svg -o /tmp/ico-$n.png; done
magick /tmp/ico-16.png /tmp/ico-32.png /tmp/ico-48.png apps/web/public/favicon.ico
cp brand/favicon.svg apps/web/public/favicon.svg
rsvg-convert -w 180 -h 180 brand/app-icon.svg -o apps/web/public/apple-touch-icon.png
rsvg-convert -w 192 -h 192 brand/app-icon.svg -o apps/web/public/icon-192.png
rsvg-convert -w 512 -h 512 brand/app-icon.svg -o apps/web/public/icon-512.png
rsvg-convert -w 512 -h 512 brand/app-icon.svg -o apps/desktop/src-tauri/icons/icon.png
for n in 16 24 32 48 64 256; do rsvg-convert -w $n -h $n brand/app-icon.svg -o /tmp/win-$n.png; done
magick /tmp/win-{16,24,32,48,64,256}.png apps/desktop/src-tauri/icons/icon.ico
rsvg-convert -w 1024 -h 1024 brand/app-icon.svg -o brand/app-icon-1024.png
rsvg-convert -w 1280 -h 640 brand/social-card.svg -o brand/social-preview.png
rsvg-convert -w 1200 -h 600 brand/social-card.svg -o apps/web/public/og-image.png
rsvg-convert -w 1600 -h 1000 brand/architecture.svg -o brand/architecture.png
rsvg-convert -w 1600 -h 900 brand/architecture-simple.svg -o brand/architecture-simple.png
rsvg-convert -w 44 -h 44 brand/favicon.svg | magick - -fill black -colorize 100 apps/desktop/src-tauri/icons/tray.png
```

**Colours** are the app's palette (`apps/web/src/styles.css`): Jet Black
`#293241`, Dusk Blue `#3d5a80`, Light Cyan `#e0fbfc`.

**Don't** outline it, stretch it, add a shadow, or close the gaps between the
pieces: the cuts are the idea.
