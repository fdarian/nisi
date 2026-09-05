# @repo/desktop

## 0.5.0

### Minor Changes

- d7cb661: ⌘⇧[ and ⌘⇧] now cycle through your open chats while the chat is open, instead of switching PR tabs.
- c8368df: A new Overview tab shows the pull request's description next to its commits, each with its short hash and CI status.
- 57267d7: nisi can now be opened directly from a GitHub pull request link — a companion Chrome extension hands the page straight to the app instead of you having to find and open the repo by hand.
- af34477: PR tabs now show their status at a glance — the tab icon turns green once a pull request is ready to merge, pulses amber while CI is running, and switches to a purple merged icon after it lands.
- 150f2c1: You can now open a file in full alongside the diff, instead of only seeing the changed lines.

### Patch Changes

- 5bd469d: You can now ask a chat about lines selected in a diff, with several selections attached at once.
- 9153947: Clicking "Ask" on a diff selection now puts the cursor straight in the chat box
- 6e07899: Long code blocks and URLs in chat replies now wrap inside the panel instead of running off the edge.
- 8445c19: The CI status now picks up a fresh push instead of waiting for the next refresh.
- a10ad7e: Claude Code now works as a harness in the installed app — enabling it lists its models instead of silently offering none.
- c8f9712: ⌘W now closes the last tab instead of quitting the whole window.
- 7bdba77: Pressing Escape in the chat composer now returns focus to the file list, so `j`/`k` immediately work to cycle files again. A second Escape closes the chat panel, and ⌘J now refocuses the composer instead of closing the panel when it's open but unfocused.
- 8089ecb: Dragging a line selection past the top or bottom of the diff now scrolls to keep selecting.
- 868e554: Harness model discovery no longer leaks a `claude`, `codex`, or `opencode` subprocess on every probe, and discovered models are now cached on disk for a day and served stale-while-revalidating instead of re-probing every few minutes.
- d592782: PR header CI status, merge button, and overview commit list now stay refreshed while the tab is watched instead of going stale after settling
- 55fbee3: The merge button now defaults to the merge method you last used in that repository.
- 7c617f3: Merging a pull request now changes the button to Merged without briefly restoring the merge action.
- bb41025: ⌘⇧J now always starts a new chat thread, alongside ⌘J's existing open/close toggle.
- 217780f: Chat now starts on the model you last sent a message with, instead of an empty picker every time.
- 4b7e2cc: The chat panel is now resizable — drag its left edge, top edge, or top-left corner. The size you pick sticks across restarts.
- 697d576: Shift+R now marks the selected file reviewed and moves to the previous file, mirroring r's move to the next.
- 5415ce3: Switching a branch review to its pull request now keeps your reviewed files and walkthrough instead of starting over.
- d7cb661: ⌘1–⌘9 now switch PR tabs even while the cursor is in a text field.
- 322801c: Use faster cn https://github.com/shadcn-ui/cn
- 6f8430e: Opening a file in Zed now opens it inside the repo, instead of on its own with no project.

## 0.4.0

### Minor Changes

- a3aefd9: You can now chat with your coding agent about the pull request you're reviewing.

### Patch Changes

- d0f731f: Select lines in a diff and copy a reference to them
- 36196e6: Long lines in a diff can now wrap instead of running off the side.
- f15ee17: "Restart to update" now installs the new version instead of relaunching the old one and offering the same update again.

## 0.3.2

### Patch Changes

- a91cf41: The collapsed-hunk control between diff hunks is now a full-width band you can click anywhere to expand, instead of a small button that could sit off-screen on files with long lines.
- dff44cb: Copy the current branch name from the ⌘K command palette or the PR header's more menu.
- 57a01b4: PR tabs can now be dragged to reorder them.
- 16d364d: Step back and forward through recently focused files in the Files Changed pane with ⌘[ and ⌘].
- 0a440e2: Fix jumping to a file while its diff is still streaming in landing at the wrong scroll position and jittering on subsequent scrolls.
- 261d00e: Marking the last file as reviewed no longer clears the selection — focus falls back to the previous file.
- a2740db: Add `o` then `e` to open the selected file in your preferred editor, and `o` then `g` to open the pull request in GitHub — set a preferred editor from Settings (⌘,) or the first press of `o e` will offer to pick one.
- ffca752: Sync the selected file to the diff pane's scroll position, so the tree highlight and `r` (mark reviewed) follow whichever file is on screen while scrolling, not just `j`/`k`/click.
- e4ef8b5: Switch a branch diff session to its pull request from the ⌘K command palette.
- 9064cd8: Show a placeholder instead of silently dropping a file from the diff pane when its diff fails to parse.
- 8ffaa47: Copy a changed file or folder's relative or absolute path.
- e8eadb7: Fix files in a brand-new, entirely untracked folder showing "Couldn't load this file's diff." instead of their content, with "Include uncommitted" on.

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
