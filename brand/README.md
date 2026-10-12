# Fabrikka's mark

A factory made of three puzzle pieces: separate parts, one plant. People and
their agents, each bringing a piece, producing something together.

| File | Use |
| --- | --- |
| `fabrikka-mark.svg` | The mark. One colour (`currentColor`), transparent, square. Use it anywhere at 48 px and up. |
| `favicon.svg` | The mark for small sizes: wider cuts so the puzzle joints survive at 16–32 px. Jet Black, Light Cyan in dark mode. |
| `app-icon.svg` | The app tile: the mark in Light Cyan on a Dusk Blue to Jet Black gradient, rounded. The desktop app, touch and install icons. |
| `app-icon-1024.png` | The tile rendered at 1024 px, for stores and press. |

Generated from these, and committed:

- `apps/web/public/favicon.svg`, `favicon.ico` (16, 32 and 48 px);
- `apple-touch-icon.png` (180 px), `icon-192.png`, `icon-512.png` and
  `site.webmanifest`;
- `apps/desktop/src-tauri/icons/icon.png` (the app, 512 px);
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
rsvg-convert -w 1024 -h 1024 brand/app-icon.svg -o brand/app-icon-1024.png
rsvg-convert -w 44 -h 44 brand/favicon.svg | magick - -fill black -colorize 100 apps/desktop/src-tauri/icons/tray.png
```

**Colours** are the app's palette (`apps/web/src/styles.css`): Jet Black
`#293241`, Dusk Blue `#3d5a80`, Light Cyan `#e0fbfc`.

**Don't** outline it, stretch it, add a shadow, or close the gaps between the
pieces: the cuts are the idea.
