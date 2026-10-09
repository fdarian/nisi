---
name: nisi-guide
description: Write the reviewer's guide for the changes you just made, as a live page in nisi's Guide tab, instead of recapping them in chat. Use after finishing a change a human will review, when asked for a guide, overview or walkthrough of your work, or when editing an existing .nisi/guide/guide.mdx.
---

# Writing a nisi guide

After you change code, don't summarise it in chat. Write a guide: one MDX file that nisi renders in the
PR's **Guide** tab, with an overview of what changed, screenshots, links into the diff, recorded check
results, and a checklist of what you need from the reviewer. The tab re-renders about 2 seconds after
each save, so write it early and keep editing.

## Where

`<repo root>/.nisi/guide/guide.mdx`, in the worktree you changed (`.nisi/` is git-ignored; never commit it).
Screenshots and any custom `.tsx` component live next to it. Import the kit from `@nisi/guide`.

## Shape

The app draws the title (the PR's own) and an "On this page" list built from your `##` headings, so
write no `# h1`. Use these sections in this order, and drop one that doesn't apply:

1. `## Overview`: one lead sentence saying what changed and why it matters, then `<Areas>`: the change
   grouped into parts. Add a `<Sequence>` before it only when the change is about ordering or timing.
2. `## See it`: screenshots of what a reviewer would see.
3. `## How it works`: one `Note` per decision or caveat, each with a short label.
4. `## Checks`: `<Checks />`.
5. `## Needs you`: `NeedsYou`, the actions only the reviewer can take.

## Writing

- Bullets over prose; a paragraph is 2 sentences or fewer.
- Every file you mention is a `<Ref path lines? />` or a backticked repo path, which links itself when
  the path is in the diff. Clicking opens that file's diff beside the guide.
- Each `Area` takes `paths` globs; nisi computes its file count and +/- from the diff, so don't write
  numbers. Every changed source file must fall in some Area (tests, stories, docs and lockfiles are exempt).
- Never write test results as prose: record them with `check.ts`.
- A `Needs you` item is an action for the reviewer ("Compare both pages with the Paper designs"), with
  a one-line how or why. Never write "I haven't…"; that is a `Skipped` check or an action.

## Before you finish

```sh
bun .claude/skills/nisi-guide/scripts/check.ts "Type check and lint" -- pnpm turbo run check:type check:lint
bun .claude/skills/nisi-guide/scripts/validate.ts
```

`check.ts` runs a command and records the result for `<Checks />`; run it after your last commit, or the
run shows as stale. `validate.ts` builds and renders the guide as the tab does and lists what to fix
(an h1, changed files no Area covers, a `Ref` to lines outside the diff, stale checks). Fix everything it
prints, then run it again. When it is clean, preview what a reader will see and look at the images:

```sh
bun .claude/skills/nisi-guide/scripts/render.ts --expand
```

`--text` is the cheap check: it prints the guide as plain text with the computed numbers, no browser needed.

## Example

```mdx
## Overview

The repository page renders from local data, then streams in each PR's state.

<Areas>
  <Area id="fetching" title="Fetching" subtitle="sidecar" paths={["apps/desktop/sidecar/**", "packages/git/src/**"]}>
    - `repositories.get` answers from local data only. <Ref path="apps/desktop/sidecar/repositories.ts" lines="40-80" />
    - A new `sessionStates` stream fills in the rest.
  </Area>
  <Area id="ui" title="UI" subtitle="Settings > Repositories" paths={["apps/desktop/src/features/settings/**"]}>
    - Every row appears on first paint; pending rows show a skeleton.
  </Area>
</Areas>

## Needs you

<NeedsYou>
  <Item id="empty-state" title="Check the empty state copy">Settings > Repositories with no repos added.</Item>
</NeedsYou>
```

## Reference

Open these only when you need them; they are not repeated here.

- `references/components.md`: every kit component with its props, and the rules for custom components. Open when you use anything beyond `Areas`, `Ref`, `Note`, `Checks` and `NeedsYou`.
- `references/sequence.md`: when a `Sequence` earns its place (ordering, timing, request flow), when to skip it, and a worked example. Open when the change is about *when* things happen.
- `references/screenshots.md`: `Shot`, `Tour`, `Pin`, `BeforeAfter`, plus capturing from Storybook, catching delayed states, and placing pins. Open before taking any screenshot.
- `references/preview.md`: the `render.ts` flags (`--expand`, `--text`, `--theme`), what to look for in the images, and its limits. Open the first time you preview, or when an image looks wrong.
- `references/checks.md`: `check.ts` usage, `Skipped`, and what counts as a check. Open when a check is long-running, needs a `cd`, or you aren't sure what to record.
