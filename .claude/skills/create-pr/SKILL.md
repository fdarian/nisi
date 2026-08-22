---
name: create-pr
description: Create a pull request for the current branch in this repo, including the changeset. Use whenever asked to open/create a PR here, or to add a changeset.
---

# Changesets

**Scope: one package.** `.changeset/config.json`'s `fixed` group ties `@repo/desktop` and `@repo/cli`
together — they always version in lockstep, whether or not both are named. No such rule exists for
any other workspace package: `@repo/walkthrough`, `@repo/git`, `@repo/review`, `@repo/db`, etc. only
get a version bump and their own changelog section when a changeset explicitly names them — nothing
pulls them in automatically just because `@repo/desktop` depends on them. So naming one is opt-in
noise for a version number nothing outside the workspace ever resolves against. List `@repo/desktop`,
or `@repo/cli` only if the change is reachable exclusively through the CLI — never an internal
package.

**Body: one line, for a nisi user.** `.github/workflows/release.yml` publishes the changelog section
as the GitHub release notes — the body IS the release note. Say what changed for the user, not what
changed in the code: no package names, no "refactored X". Two lines max if genuinely needed.

**Cut the mechanism.** One sentence is the limit, and it's easy to obey the letter while stuffing in
three clauses of how it works — where the button lives, what it polls, how often. A user reading
release notes wants the capability, not its implementation. Name what they can now do; drop the UI
location, the interval, the trigger, and the sequence of steps. If a clause would still be true after
a rewrite of the feature, it probably belongs; if it describes this particular build of it, cut it.

**Skip the changeset entirely** for docs, tests, CI, and internal refactors with no behavior change.

### Good
```md
---
"@repo/desktop": patch
---

Ticking Reviewed no longer snapshots the wrong branch's content when the session's head isn't the
checked-out branch.
```

### Bad
```md
---
"@repo/walkthrough": patch
"@repo/desktop": patch
---

Switched the walkthrough agent's buffer format from JSON to markdown and refactored
`serializeDocument` to share the parser between generation and regeneration.
```
`@repo/walkthrough` isn't in the fixed group and nothing else versions it automatically — naming it
here is what gives it its own bump and changelog section. The body also describes the
implementation, not what a nisi user sees.

### Bad
```md
---
"@repo/desktop": minor
---

Add self-update for the Homebrew-cask install: the app checks the tap hourly and shows a pill in the
tab strip to download and restart into the new version.
```
One sentence, but three clauses of mechanism. The hourly poll, the pill, the tab strip, and the
download-then-restart sequence are all implementation. `nisi can now update itself when it was
installed via Homebrew.` is the release note.

# PR body

Match the shape already used in this repo's merged PRs: `## Summary`, `## Why`, `## Test plan`. Keep
it tight — existing PRs run long; don't. Don't repeat the changeset text verbatim.

# Steps

1. Gather context: `git log main..HEAD --oneline`, `git diff main...HEAD --stat`, `git branch --show-current`.
2. Add a changeset if the diff needs one (see above): `.changeset/<slug>.md`.
3. Write the PR body to `/tmp/<slug>.md`, then push and open the PR. Title as a plain, capitalized
   sentence describing the change (`Support nisi diff <base>..<head> for two arbitrary branches`) —
   most merged PRs here skip a `feat:`/`fix:` prefix entirely.
   ```sh
   git push -u origin $(git branch --show-current)
   gh pr create --title "<title>" --body-file /tmp/<slug>.md
   ```
4. Return the PR URL.


