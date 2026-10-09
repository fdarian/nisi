---
name: nisi-guide
description: Write the reviewer's guide for the changes you just made, as a live page in nisi's Guide tab, instead of recapping them in chat. Use after finishing a change a human will review, when asked for a guide or walkthrough of your work, or when editing an existing .nisi/guide/guide.mdx.
---

# Writing a nisi guide

After you change code, don't summarise it in chat. Write a guide: one MDX file that nisi renders in the
PR's **Guide** tab, with screenshots, annotated pins, links into the diff, and a checklist of what
you need from the reviewer. The tab re-renders about 2 seconds after each save, so write it
early and keep editing.

## Where

`<repo root>/.nisi/guide/guide.mdx` (the root of the worktree you changed; `.nisi/` is git-ignored).
Anything it imports lives next to it: screenshots, and `.tsx` files if you need a component the kit
lacks. Don't commit any of it.

## Shape

Lead with the outcome, show the change, then explain the decisions, then ask for what you need.

1. `Outcome`: one headline and a sentence or two. A reader who stops here should know what happened.
2. `Shot`, `Tour` or `BeforeAfter`: show it. Pick by what you're showing (below).
3. `Note`s: one per decision or caveat, with `Ref`s to the code behind it.
4. `NeedsYou`: what you couldn't verify and what only the reviewer can decide.

Plain Markdown (headings, lists, tables, code fences) works between the components.

## Kit

Import from `@nisi/guide`:

| Component | Use |
| --- | --- |
| `Outcome { title?, children }` | The lead block. |
| `Shot { src, alt, caption? }` + `Pin { x, y }` | One screenshot. `x` and `y` are percentages of the image; pins are numbered in order and their children are the legend. Pins must be direct children. |
| `Tour` + `Frame { title, src? }` | A flow, one frame at a time with a filmstrip and arrow keys. Frames take `Pin`s; a frame without `src` renders its children instead. |
| `BeforeAfter { before, after }` | Side by side. Each side is an image src or any node. |
| `Note { label }` | A decision or caveat. Put `Ref`s in its body. |
| `Ref { path, lines? }` | Opens the file in the session, scrolled to `lines` (`"12-30"`). `path` is repo-relative; a path outside the PR's diff is flagged "not in diff", so link the diff's own files. |
| `NeedsYou` + `Item { id }` | A tickable list. Ticks are remembered per `id`, so keep ids stable when you rewrite the guide. |

```mdx
import { Outcome, Shot, Pin, Note, Ref, NeedsYou, Item } from "@nisi/guide";
import settings from "./settings.png";

<Outcome title="Repositories now live under Settings">
  The list and each repo's sessions moved out of the sidebar.
</Outcome>

<Shot src={settings} alt="Settings > Repositories" caption="Settings, after">
  <Pin x={12} y={30}>Open counts come from the index, no GitHub call</Pin>
</Shot>

<Note label="Lookups never fail the page">
  A failed PR-state lookup marks one row `unresolved`. See <Ref path="apps/desktop/sidecar/repositories.ts" lines="40-80" />.
</Note>

<NeedsYou>
  <Item id="empty-state">Is the empty state copy right?</Item>
</NeedsYou>
```

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
