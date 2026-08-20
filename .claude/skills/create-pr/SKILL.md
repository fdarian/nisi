---
name: create-pr
description: Create a pull request for the current branch in this repo, including the changeset. Use whenever asked to open/create a PR here, or to add a changeset.
---

# Changesets

**Scope: one package.** `.changeset/config.json` fixes `@repo/desktop` and `@repo/cli` together and
versions private packages, so every package named in a changeset gets its own version bump and its
own changelog section — naming an internal package (`@repo/walkthrough`, `@repo/git`, `@repo/review`,
`@repo/db`, etc.) is pure release noise. List `@repo/desktop`, or `@repo/cli` only if the change is
reachable exclusively through the CLI. Everything else bumps automatically via the fixed group.

**Body: one line, for a nisi user.** `.github/workflows/release.yml` publishes the changelog section
as the GitHub release notes — the body IS the release note. Say what changed for the user, not what
changed in the code: no package names, no "refactored X". Two lines max if genuinely needed. A
version bump with no user-visible story gets an empty body (valid changesets syntax).

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
`@repo/walkthrough` is internal — it rides the fixed group already. The body describes the
implementation, not what a nisi user sees.

# PR body

Match the shape already used in this repo's merged PRs: `## Summary`, `## Why`, `## Test plan`. Keep
it tight — existing PRs run long; don't. Don't repeat the changeset text verbatim.

# Steps

1. Gather context: `git log main..HEAD --oneline`, `git diff main...HEAD --stat`, `git branch --show-current`.
2. Add a changeset if the diff needs one (see above): `.changeset/<slug>.md`.
3. Write the PR body to `/tmp/<slug>.md`, then push and open the PR:
   ```sh
   git push -u origin $(git branch --show-current)
   gh pr create --title "<title>" --body-file /tmp/<slug>.md
   ```
4. Return the PR URL.
