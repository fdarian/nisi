# Previewing the guide

`render.ts` shows the guide as the reader sees it, without opening the app. Use it to check that pins sit on what they point at, that the Overview says what you meant, and (when something looks wrong in the tab) to tell a guide problem from an app one.

```sh
bun .claude/skills/nisi-guide/scripts/render.ts [--expand] [--text] [--theme light|dark] [--width <px>] [--scale <n>] [--base <ref>]
```

It builds the guide exactly as the tab does and renders the real kit with real data: each Area's file count and +/- from the diff against the merge-base, the recorded checks (stale marks included), and the head commit. The app's own stylesheet is compiled for the page, so what you see is the app's styling in light or dark.

## PNGs (the default)

One PNG per `##` section plus `full.png`, in `.nisi/guide/.preview/` (git-ignored, and not part of what the tab rebuilds on). The script prints the paths; open the images and look at them. A fresh headless Chrome with a throwaway profile takes the screenshots, so it never touches a browser you have open; set `CHROME_PATH` if it can't find one. A run takes about 8 seconds.

- `--expand` stacks every Tour frame, shows Before and After of each Sequence, and opens each Area's file list, so every pin and state is on the page at once. The tab shows one at a time, so use `--expand` whenever you want to check everything, and the default to see what a reader lands on.
- `--theme dark` for dark mode. Check pin legibility and step colors in both if the change touches visuals.
- `--width` (default 900) is the viewport; the guide's own column is at most 768px. `--scale 2` gives sharper images when a pin is hard to place.

What to look for:

- **Pins:** each marker on the thing its legend line names. If not, re-measure (see `screenshots.md`).
- **Overview:** the lead sentence and Area bullets read as a summary a reviewer could stop at; every Area's file count is plausible; a Sequence's steps read in the order things happen, and each lane's waits line up with the step they wait for.
- **Checks:** every run present and current.

## Text (the cheap check)

`--text` prints the page as plain text, expanded, with the computed values filled in, and launches nothing, so it takes a second:

```
### Authoring
skill · scripts 4 files +523 −0
- `check.ts` runs a command and records it.
- ⟨check.ts⟩ +113 −0
...
## Checks
- [Passed] Type check and lint `pnpm turbo run check:type` at 330b859
- [Failed, exit 1] Unit tests `bun test` at 0123456 stale
```

`⟨…⟩` is a `Ref`, `[…]` is a Sequence step (`[wait]` and `[event]` for the rest), pin captions are numbered per frame, and `[x]` / `[ ]` are ticks. Use it to confirm what the guide says and that the numbers are right; use the PNGs for anything visual.

## Limits

It is a static render: no hover, no clicks, and a custom component's effects and fetches don't run, so such a component shows its first-render state. A Check's output stays collapsed.
