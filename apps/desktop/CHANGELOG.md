# @repo/desktop

## 0.3.1

### Patch Changes

- 1f1a77c: Fixed the diff pane's scroll position collapsing to the top when you clicked a file in the sidebar and immediately ticked its Reviewed checkbox with "Hide Reviewed" on.

## 0.3.0

### Minor Changes

- 1bedb06: nisi can now update itself when it was installed via Homebrew.

### Patch Changes

- 7646c91: The CI status dropdown now opens a check's run on GitHub when you click it.
- 9b61c6a: Scrolling through a diff no longer jitters.
- 2cec4fc: The PR merge button no longer has a visible border or shadow outline.
- b63d1bf: Right-clicking a PR tab now offers "Close other tabs" (⌘⌥W), alongside a shortcut hint for the existing "Close" (⌘W).
- 6afb377: `nisi` no longer brings the production app forward when pointed at a dev sandbox via `NISI_DATA_DIR`.

## 0.2.4

### Patch Changes

- fcd25ba: Switch the walkthrough agent's buffer from a JSON string to a markdown document, and add a `read_walkthrough` tool so the agent can re-sync before editing.

## 0.2.3

### Patch Changes

- ec6a4cf: `nisi diff <base>..<head>` reviews two branches against each other, neither of which has to be checked out. `a..b` and `a...b` both mean what `head` added since diverging from `base`.
- b79671f: The walkthrough tab's diff now renders as bordered cards matching the Files Changed tab.
- ec6a4cf: Fix ticking Reviewed snapshotting the wrong branch's content when the session's head isn't the checked-out branch. The bad snapshot survived reopens.
- e68112e: The walkthrough agent narrates only what matters instead of linking every changed hunk, and explores the worktree itself rather than working from a pre-truncated patch dump. Files it skipped are listed under the walkthrough — click one to see its hunks.
- e68112e: Regenerating a walkthrough no longer requires waiting for the files to drift — the control sits at the bottom of the narrative pane at all times.

## 0.2.2

### Patch Changes

- c445d8e: Fix Files Changed stuttering and jumping while scrolling. The file-contents query was returning a new Map identity on every render, forcing every visible diff card to rebuild, and placeholder cards (generated, binary, error, and already-reviewed files) were rebuilding their annotation objects each render — discarding the measured heights `@pierre/diffs` relies on to hold your scroll position.
- e3722f2: Fix walkthrough generation failing with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY when the reviewed repo sits inside a pnpm workspace — the claude-code, codex, and opencode harnesses now bootstrap their CLI install under ~/.nisi/harness-sandbox instead of the repo's parent directory.
- d8552ed: The "About nisi" menu item now opens a native-styled About window instead of the plain macOS panel, showing the app version and the exact commit the build was produced from, linked to its page on GitHub.
- 60461d2: A PR tab left in the background for 5 minutes now suspends, freeing its diff content from memory — selecting it again resumes right where you left off. Suspended tabs show a leaf icon, and right-clicking any tab lets you suspend it immediately instead of waiting out the timer.
- 4c3451d: Fix the diff pane sometimes showing stale file content that only cleared on app relaunch.
- 777b878: Closing a PR tab now releases its diff content from memory. A leak in `@pierre/diffs` kept every file view of a closed tab subscribed to a global worker-pool singleton, pinning its diff text for the lifetime of the app.

## 0.2.1

### Patch Changes

- 1b6f515: Running `nisi` while the app is already open now brings the window to front and switches to the newly opened tab, instead of leaving both untouched.

## 0.2.0

### Minor Changes

- d24d09c: Initial release
