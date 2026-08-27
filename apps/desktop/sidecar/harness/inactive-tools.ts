import type { HarnessId } from "@repo/sidecar-api";

/**
 * Each adapter's builtin tools that write to the filesystem — the shared
 * `inactiveTools` list for any `HarnessAgent` that must stay read-only.
 * Walkthrough generation is prose *about* a diff and chat is a read-only Q&A
 * agent; neither ever needs to modify the worktree, and the worktree is the
 * user's real repo, not a disposable sandbox. Claude Code proved the risk
 * concrete: on a large context payload it called its builtin `Write` rather
 * than walkthrough's own tool and left a stray `walkthrough.json` in the repo
 * root.
 *
 * A caller that also registers its own tools under these same names (e.g.
 * walkthrough's `write_walkthrough`/`edit_walkthrough`, see
 * `WALKTHROUGH_TOOL_NAMES`) should rename them out of the way too, so the
 * model doesn't *confuse* the two — this constant only stops it from
 * reaching a file writer at all, whichever one it reaches for. Codex exposes
 * no file-writing builtin (only `bash`/`webSearch`), hence the empty list.
 *
 * `bash` is deliberately left active in every case — an agent needs it to
 * explore the worktree, and it's the one remaining way to touch disk. That's
 * a narrower hole than an editing tool the model reaches for by habit, but
 * it is a hole.
 */
export const FILE_MUTATING_BUILTINS: Record<
	HarnessId,
	ReadonlyArray<string>
> = {
	"claude-code": ["write", "edit", "NotebookEdit"],
	codex: [],
	opencode: ["write", "edit"],
	pi: ["write", "edit"],
};
