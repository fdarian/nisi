---
name: nisi-guide
description: Write the reviewer's guide for the changes you just made, as a live page in nisi's Guide tab, instead of recapping them in chat. Use after finishing a change a human will review, when asked for a guide or walkthrough of your work, or when editing an existing .nisi/guide/guide.mdx.
---

# Writing a nisi guide

After you change code, don't summarise it in chat. Write a guide: one MDX file that nisi renders in the
PR's **Guide** tab, with screenshots, annotated pins, links into the diff, recorded check results, and
a checklist of what you need from the reviewer. The tab re-renders about 2 seconds after each save,
so write it early and keep editing.

## Where

`<repo root>/.nisi/guide/guide.mdx` (the root of the worktree you changed; `.nisi/` is git-ignored).
Anything it imports lives next to it: screenshots, and `.tsx` files if you need a component the kit
lacks. Don't commit any of it.

## Shape

The app draws the page chrome: the title, and an "On this page" list built from your `##` headings.
You write the content, in this order:

1. `# Title` stating the outcome, then 2 to 4 bullets saying what changed. A reader who stops here
   should know what happened.
2. `## See it`: `Shot`, `Tour` or `BeforeAfter` (below).
3. `## How it works`: one `Note` per decision or caveat, each with a short label.
4. `## Checks`: `<Checks />`.
5. `## Needs you`: `NeedsYou`.

Rename or drop a section that doesn't apply (a change with nothing to see has no "See it"), but keep
the order.

## Writing

- Prefer bullets to prose. A paragraph is 2 sentences or fewer.
- Every file you mention is a `Ref`, or a backticked repo path (`` `apps/desktop/sidecar/guide/build.ts:70-95` ``),
  which links itself when the path is in the diff. Clicking opens that file's diff beside the guide.
- Never write test results as prose. Run the command through `check.ts` (below) so it shows up in `<Checks />`.

## Kit

Import from `@nisi/guide`:

| Component | Use |
| --- | --- |
| `Shot { src, alt, caption? }` + `Pin { x, y }` | One screenshot. `x` and `y` are percentages of the image; pins are numbered in order and their children are the legend. Pins must be direct children. Clicking a pin jumps to its legend entry. |
| `Tour` + `Frame { title, src? }` | A flow, one frame at a time with a filmstrip and arrow keys. Frames take `Pin`s; a frame without `src` renders its children instead. |
| `BeforeAfter { before, after }` | Side by side. Each side is an image src or any node. |
| `Note { label }` | A decision or caveat. The label is its heading; the body is muted. Put `Ref`s in the body. |
| `Ref { path, lines? }` | Shows the file's basename (`lines` like `"12-30"`); the full path is on hover. A path outside the PR's diff is flagged "not in diff". |
| `Checks` + `Skipped { title }` | Every run recorded by `check.ts`, with its command, short commit and expandable output; a run at an older commit is marked stale. `Skipped` children list what you deliberately didn't run, with the reason as its body. |
| `NeedsYou` + `Item { id, title }` | A tickable list. `title` is an action for the reviewer; the children are a one-line how or why. Ticks are remembered per `id`, so keep ids stable when you rewrite the guide. |

```mdx
import { Shot, Pin, Note, Ref, Checks, Skipped, NeedsYou, Item } from "@nisi/guide";
import settings from "./settings.png";

# Repositories now live under Settings

- The list and each repo's sessions moved out of the sidebar.
- Open counts come from the index, so the page makes no GitHub call.

## See it

<Shot src={settings} alt="Settings > Repositories" caption="Settings, after">
  <Pin x={12} y={30}>Open counts come from the index</Pin>
</Shot>

## How it works

<Note label="Lookups never fail the page">
  A failed PR-state lookup marks one row `unresolved`. See <Ref path="apps/desktop/sidecar/repositories.ts" lines="40-80" />.
</Note>

## Checks

<Checks>
  <Skipped title="Run against real GitHub">Tests use a fake `gh`.</Skipped>
</Checks>

## Needs you

<NeedsYou>
  <Item id="empty-state" title="Check the empty state copy">Settings > Repositories with no repos added.</Item>
</NeedsYou>
```

## Checks

Run each check through the script; don't run it bare and then describe the result:

```sh
bun .claude/skills/nisi-guide/check.ts "Type check and lint" -- pnpm turbo run check:type check:lint
```

It runs the command in the repo root, streams its output, exits with the command's exit code, and
records the run (command, exit code, duration, commit, last 40 lines of output) in
`.nisi/guide/checks/`. `<Checks />` lists every recorded run. A command that needs `cd` or `&&` goes
in one quoted argument. Re-run after your last commit, or the runs show as stale. Use the same title
to replace an earlier run. For something you didn't run, add a `<Skipped title="…">reason</Skipped>`
inside `<Checks>`.

## Needs you

Each item is an action the reviewer takes, with a title and a one-line detail ("Compare both pages
with the Paper designs" / "`bun dev`, then Settings > Repositories"). Don't write "I haven't…" or
"not verified"; that's a `Skipped` check, or an action for the reviewer.

## Rules

- **Use the kit first.** Write a custom component only when nothing above can show it. Put it in a
  `.tsx` file next to `guide.mdx`, `import` it, and import the kit from `@nisi/guide` inside it. It may
  import from the repo's own source.
- Imports resolve to `react`, `@nisi/guide`, relative files and images. Nothing else is available (no
  npm packages, no `fetch`).
- A build error or a throwing component shows inline in the tab with its message; fix and save.

## Screenshots

Save PNGs into `.nisi/guide/` and import them: `import shot from "./settings.png"`. Capture them the
way you'd verify the change (a storybook story, the dev app, a browser tool). Crop to the relevant
region; pins are positioned as a percentage of the image, so cropping tightly makes them land well.
Prefer 2 to 6 images over many.
