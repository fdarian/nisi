# Screenshots

Show what a reviewer would see, not what the code looks like. Aim for 2 to 6 images in total.

## Components

- `Shot { src, alt, caption? }` with `Pin { x, y }` children: one image with numbered markers. `x` and `y` are percentages of the image from its top left. A pin's children are its legend entry. Pins must be direct children of the `Shot`. Clicking a marker scrolls to its legend entry; clicking a number highlights the marker.
- `Pin { x, y, ring?, side? }`: add `ring` when the target is small (an icon, a dot, one character). It draws a ring around the exact point and puts the numbered badge beside it on a short leader line, so the badge doesn't cover what it points at. By default the badge goes on the side with the most room in the image; set `side="left|right|top|bottom"` when that side would cover text. Clicking and hovering link to the legend the same as for any pin. Use plain pins for large targets (a row, a panel).
- `Tour` with `Frame { title, src? }` children: a flow, one frame at a time, with a filmstrip and arrow keys. Frames take `Pin`s the same way. A frame without `src` renders its children as the stage.
- `BeforeAfter { before, after }`: two images side by side, for a change to something that already existed.

```mdx
import settings from "./settings.png";

<Shot src={settings} alt="Settings > Repositories" caption="Settings, after">
  <Pin x={12} y={30}>Open counts come from the index</Pin>
  <Pin x={88} y={8} ring side="left">The new sync icon</Pin>
</Shot>
```

Save PNGs into `.nisi/guide/` and import them; the bundle inlines them.

## Placing pins

Pin percentages are relative to the image you import, the final cropped file, not to the screen or the original capture. So crop first and place pins after; re-cropping moves every target.

1. Crop to the region that matters. A pin on a 400px-wide crop is far easier to place than one on a full window.
2. Get the cropped file's size: `sips -g pixelWidth -g pixelHeight .nisi/guide/shot.png` (macOS), or `file shot.png`.
3. Find the pixel of the thing you are pointing at (your browser tool's element bounding box, minus the crop offset).
4. `x = px / width * 100`, `y = py / height * 100`, rounded to a whole number.
5. Run `render.ts --expand` (see `preview.md`) and look at the section image: a pin sits on the edge or corner of its target, not over its text.

## Capturing

Capture the way you'd verify the change yourself. Whatever renders the real component with real-looking data will do: a component-gallery story, the dev app, a browser tool on a scratch instance.

- **A state with no story.** Write a throwaway story (or page) that renders just that state, capture it, then delete the story. A story you only needed for one image is clutter for the next person; a story worth keeping belongs in its own change.
- **A before shot.** Check out the base in a temporary worktree (`git worktree add /tmp/base <base-ref>`), run the same story or page there with the same fixture data, capture, then remove the worktree. Same data on both sides, or the comparison shows the data and not the change.
- **A fixture too small to show the problem.** If the existing fixture is too small or too tidy for the problem to appear (a 3-row list for a change about 300 rows), build a larger fixture, and say so in the guide: "shot uses a 300-row fixture; the original fixture has 3 rows". A reviewer should know the image is staged.
- **A state that exists for a moment** (a list mid-stream, a skeleton, a spinner). You will not catch it by racing a screenshot; park it. Hold a query pending forever in the fixture, give the fixture exactly the half-resolved mix you want, or add a prop or `play` step that sets the state, rather than a sleep.

## In the nisi repo

Stories render a component against fixture data, with no sidecar and no agent run. In `apps/desktop`:

- Start Storybook with the `storybook` entry in `.claude/launch.json` (it runs `pnpm exec storybook dev -p $PORT --ci` on a free port; read the port from its log). `pnpm run storybook` pins port 6006 and can collide with another session's.
- Open a story's own page, without Storybook's chrome: `http://localhost:<port>/iframe.html?id=<story-id>&viewMode=story`. The id is the story title lowercased and hyphenated, then `--` and the export name: `Settings/Repositories/List` with an exported `Default` is `settings-repositories-list--default`. Add `&globals=theme:dark` for dark mode.
- Set the viewport first (about 1000 x 700 for a page, smaller for a component), wait for fonts and the diff worker to paint, and write scratch captures to `apps/desktop/.storybook-shots/` (git-ignored), then copy the keepers into `.nisi/guide/`.
- Fixture data goes through `.storybook/mock-orpc.ts`'s `createMockOrpc`. Its query fixtures are pending forever when `{ pending: true }` or omitted (`MockResult`, `neverSettles`); stories named `Loading` do exactly that, and a `runningGeneration` fixture parks the walkthrough mid-run.
