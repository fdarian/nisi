# Screenshots

Show what a reviewer would see, not what the code looks like. Aim for 2 to 6 images in total.

## Components

- `Shot { src, alt, caption? }` with `Pin { x, y }` children: one image with numbered markers. `x` and `y` are percentages of the image from its top left. A pin's children are its legend entry. Pins must be direct children of the `Shot`. Clicking a marker scrolls to its legend entry; clicking a number highlights the marker.
- `Pin { x, y, ring? }`: add `ring` when the target is small (an icon, a dot, one character). It draws a ring around the exact point and puts the numbered badge beside it on a short leader line, so the badge doesn't cover what it points at. Clicking and hovering link to the legend the same as for any pin. Use plain pins for large targets (a row, a panel).
- `Tour` with `Frame { title, src? }` children: a flow, one frame at a time, with a filmstrip and arrow keys. Frames take `Pin`s the same way. A frame without `src` renders its children as the stage.
- `BeforeAfter { before, after }`: two images side by side, for a change to something that already existed.

```mdx
import settings from "./settings.png";

<Shot src={settings} alt="Settings > Repositories" caption="Settings, after">
  <Pin x={12} y={30}>Open counts come from the index</Pin>
  <Pin x={88} y={8} ring>The new sync icon</Pin>
</Shot>
```

Save PNGs into `.nisi/guide/` and import them; the bundle inlines them. Crop to the relevant region before you place pins.

## Capturing from Storybook

Stories render a component against fixture data, with no sidecar and no agent run. In `apps/desktop`:

- Start it with the `storybook` entry in `.claude/launch.json` (it runs `pnpm exec storybook dev -p $PORT --ci` on a free port; read the port from its log). `pnpm run storybook` pins port 6006 and can collide with another session's.
- Open a story's own page, without Storybook's chrome: `http://localhost:<port>/iframe.html?id=<story-id>&viewMode=story`. The id is the story title lowercased and hyphenated, then `--` and the export name: `Settings/Repositories/List` with an exported `Default` is `settings-repositories-list--default`.
- Add `&globals=theme:dark` for dark mode.
- Screenshot with whatever browser tool you have. Set the viewport first (about 1000 x 700 for a page, smaller for a component), wait for fonts and the diff worker to paint, and write scratch captures to `apps/desktop/.storybook-shots/` (git-ignored), then copy the keepers into `.nisi/guide/`.
- If no story shows the state you need, write one next to the component (`*.stories.tsx`). Fixture data goes through `.storybook/mock-orpc.ts`'s `createMockOrpc`.

## States that only exist for a moment

A list mid-stream, a skeleton, a spinner: you will not catch them by racing a screenshot. Park the state instead.

- The mock sidecar leaves a query pending forever when its fixture is `{ pending: true }` or omitted (see `MockResult` and `neverSettles` in `.storybook/mock-orpc.ts`). Stories named `Loading` do exactly this, and a `runningGeneration` fixture parks the walkthrough mid-run.
- For a state in between (some rows resolved, some pending), give the fixture that mix and no more events, or add a story variant that does.
- If the component's own timer drives the state, add a story prop or a `play` function that sets it, rather than a sleep.

## Placing pins

Pin percentages are measured against the image you import, so measure the cropped file, not the screen:

1. Get the image size: `sips -g pixelWidth -g pixelHeight .nisi/guide/shot.png`.
2. Find the pixel of the thing you are pointing at (from your browser tool's element bounding box, minus the crop offset).
3. `x = px / width * 100`, `y = py / height * 100`, rounded to a whole number.
4. Run `render.ts --expand` (see `preview.md`) and look at the section image: a pin should sit on the edge or corner of its target, not cover it.

Crop tight; a pin on a 400px-wide crop is far easier to place than one on a full window.
