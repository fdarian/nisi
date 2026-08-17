# @repo/desktop

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
