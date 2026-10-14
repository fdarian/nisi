# @repo/cli

## 0.7.0

### Minor Changes

- 18306aa: `nisi guide check|validate|render` author the walkthrough guide at `.nisi/guide` from any repo: record a check, validate the guide against the diff, and preview it as screenshots or text.
- 18306aa: Add `nisi skills`: list, get (with `--ref` and `--full`), path and stub for the agent skills embedded in the CLI. The guide-authoring skill now lives in the CLI, and the repo's `.claude/skills/nisi-guide` is a stub that points at `nisi skills get guide`.

### Patch Changes

- 12b2712: `nisi debug` prints the running app's in-memory state per open session (worktree existence and HEAD, watched state, last merge status and whether it's still polled) plus recent RPC failures, flagging anything that looks stuck.

## 0.6.1

## 0.6.0

## 0.5.0

## 0.4.0

## 0.3.2

## 0.3.1

## 0.3.0

## 0.2.4

## 0.2.3

### Patch Changes

- ec6a4cf: `nisi diff <base>..<head>` reviews two branches against each other, neither of which has to be checked out. `a..b` and `a...b` both mean what `head` added since diverging from `base`.
- 22a9c58: `nisi diff <TAB>` now completes branch and tag names, including the head side of a `base..head` or `base...head` range. Run `eval "$(nisi completion zsh)"` in your zsh startup file to enable it.

## 0.2.2

## 0.2.1

### Patch Changes

- 1b6f515: Running `nisi` while the app is already open now brings the window to front and switches to the newly opened tab, instead of leaving both untouched.

## 0.2.0

### Minor Changes

- d24d09c: Initial release
