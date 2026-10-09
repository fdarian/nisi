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

`<repo root>/.nisi/guide/guide.mdx`, in the worktree you changed. Screenshots and any custom `.tsx`
component live next to it. Import the kit from `@nisi/guide`. `.nisi/` isn't ignored by git unless the
repo says so: add it to `.git/info/exclude` (`echo .nisi/ >> "$(git rev-parse --git-path info/exclude)"`)
so it stays out of your commits, and never commit it.

## Shape

The app draws the title (the PR's own) and an "On this page" list built from your `##` headings, so
write no `# h1`. Use these sections in this order, and drop one that doesn't apply:

1. `## Overview`: one lead sentence saying what changed and why it matters, then `<Areas>`: the change
   grouped into parts. Add a `<Sequence>` before it only when the change is about ordering or timing.
2. `## See it`: screenshots of what a reviewer would see, when the change is visible and you can run it locally. If it isn't visible or the repo can't run locally, drop the section (and say so in one line); see `references/screenshots.md`.
3. `## How it works`: one `Note` per decision or caveat, each with a short label.
4. `## Checks`: `<Checks />`.
5. `## Needs you`: `NeedsYou`, the actions only the reviewer can take.

## Writing

- Bullets over prose; a paragraph is 2 sentences or fewer (`nisi guide validate` rejects a longer `Note` paragraph).
- Every file you mention is a `<Ref path lines? />` or a backticked repo path, which links itself when
  the path is in the diff. Clicking opens that file's diff beside the guide. Cite a path once: either
  the Ref or the backticked path, never both in the same paragraph (it renders twice).
- Each `Area` takes `paths` globs; nisi computes its file count and +/- from the diff, so don't write
  numbers. Every changed hunk of source must fall in some Area (tests, stories, docs, images and
  generated files are exempt).
- A file shared by two areas: claim its hunks with `path:lines`.
- Group dependency and tooling bumps (lockfile churn, config, CI) into one Area instead of one each.
- Never write test results as prose: record them with `nisi guide check`.
- A `Needs you` item is an action for the reviewer ("Compare both pages with the Paper designs"), with
  a one-line how or why. Never write "I haven't…"; that is a `Skipped` check or an action.

## Before you finish

```sh
nisi guide check "Type check and lint" -- <the repo's check command>
nisi guide validate
```

`nisi guide check` runs a command and records the result for `<Checks />`. Record the repo's standard
check commands (from its package scripts, CI, or AGENTS.md), plus an explicit command for any tests you
touched that the default script doesn't cover. Run them after your last code change; committing first
isn't required (a run on uncommitted work is marked as such, and a commit made after the run makes it
stale). `nisi guide validate` builds and renders the guide as the tab does and lists
what to fix (an h1, changed hunks no Area covers, a `Ref` to lines outside the diff, stale checks). Fix
everything it prints, then run it again. When it is clean, preview what a reader will see to check your
own work (recommended, not required):

```sh
nisi guide render --expand
```

`--text` is the cheap check: it prints the guide as plain text with the computed numbers, no browser needed. Open the images when you placed pins.

`nisi` is the app's command line, so it works from any repo. `validate` and `render` ask the app's sidecar
to do the work, and `nisi` launches the app when it isn't running (`check` never needs it). The first call
can take a few seconds while it starts. If you work on nisi itself with a dev build, set `NISI_DATA_DIR`
to the dev sandbox's data dir (the line `bun dev` prints), or run the CLI from source
(`bun packages/cli/src/index.ts guide …`), so you reach the dev sidecar and not the installed app.

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
- `references/screenshots.md`: when to take screenshots and when to skip them, `Shot`, `Tour`, `Pin`, `BeforeAfter`, capturing, catching delayed states, and placing pins. Open before taking any screenshot.
- `references/preview.md`: the `nisi guide render` flags (`--expand`, `--text`, `--theme`), what to look for in the images, and its limits. Open the first time you preview, or when an image looks wrong.
- `references/checks.md`: which commands to record, `nisi guide check` usage, uncommitted work, `Skipped`. Open when a check is long-running, needs a `cd`, or you aren't sure what to record.
