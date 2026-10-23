# Brand assets

The mark is a lowercase **n** whose right stem is painted in the same orange the app uses for its
"changed after review" dot (`orange-500`). The letter is one shape, but only part of it is lit: the
settled side stays quiet, the open side is the only thing asking for attention — which is the whole
argument of the tool. It's a letterform rather than a pictogram because the accent had to be a mass,
not a detail; a dot marker is under one device pixel at 16px, a stem is not.

| File            | Use                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------- |
| `logo.svg`      | The mark. Body is `currentColor`, accent is fixed orange.                                      |
| `logo-mono.svg` | Same geometry, entirely `currentColor` — for one-colour contexts.                              |
| `icon.svg`      | App icon: the mark on a graphite superellipse, drawn to the macOS grid (824 in a 1024 canvas). |
| `icon-1024.png` | Render of `icon.svg`, and the master `icon.icns` is generated from.                            |

The packaged app's icon is `apps/desktop/build/icon.icns` (read by `electron-builder.yml`). Regenerate it
after changing `icon.svg`:

```bash
rsvg-convert -w 1024 -h 1024 assets/icon.svg -o assets/icon-1024.png
mkdir /tmp/icon.iconset
for s in 16 32 128 256 512; do
  sips -z $s $s assets/icon-1024.png --out /tmp/icon.iconset/icon_${s}x${s}.png
  sips -z $((s*2)) $((s*2)) assets/icon-1024.png --out /tmp/icon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/icon.iconset -o apps/desktop/build/icon.icns
```
