import type {
	RepositoryDetail,
	RepositorySession,
	RepositorySessionStateBatch,
	RepositorySummary,
} from "@repo/sidecar-api";
import { STORY_HOME_DIR } from "./repositories-story-harness";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const codePath = (name: string) => `${STORY_HOME_DIR}/code/${name}`;

export const REPOSITORIES: readonly RepositorySummary[] = [
	{
		owner: "fdarian",
		repo: "nisi",
		path: codePath("fdarian/nisi"),
		openCount: 2,
		sessionCount: 50,
		problem: null,
	},
	{
		owner: "vercel",
		repo: "next.js",
		path: codePath("vercel/next.js"),
		openCount: 1,
		sessionCount: 12,
		problem: null,
	},
	{
		owner: "acme",
		repo: "web-app",
		path: codePath("acme/web-app"),
		openCount: 0,
		sessionCount: 8,
		problem: null,
	},
	{
		owner: "acme",
		repo: "legacy-api",
		path: codePath("acme/legacy-api"),
		openCount: 0,
		sessionCount: 3,
		problem: "path-missing",
	},
	{
		owner: "fdarian",
		repo: "dotfiles",
		path: codePath("dotfiles"),
		openCount: 0,
		sessionCount: 5,
		problem: "origin-mismatch",
	},
	{
		owner: "contoso",
		repo: "internal-tools",
		path: null,
		openCount: 0,
		sessionCount: 2,
		problem: "no-path",
	},
];

const TITLES: readonly string[] = [
	"Walkthrough claims link to line ranges in the diff view",
	"Keep merge status fresh after a force-push to the PR head",
	"Fix merged and reused PR diffs, and keep merge status fresh",
	"Share one GFM markdown renderer for PR description and walkthrough",
	"Make the o g open-in-GitHub shortcut PR-wide",
	"Add nisi debug: read-only snapshot of the running sidecar",
	"Persist tracked-change snapshots in the content-addressed blob store",
	"Reconcile reviewed ranges across rebases",
	"Show reviewed→head diff when a file changed since the last pass",
	"Teach the CLI to hand a PR off to the running app",
	"Resolve repo paths from a verified sibling directory",
	"Stop polling merge status for tabs nobody is looking at",
	"Collapse unchanged context in already-reviewed hunks",
	"Add a Repositories page to Settings",
	"Surface scheduled merges in the PR header",
	"Pin the diff base to the merge commit once a PR is merged",
	"Retry the sidecar handshake when the port file is stale",
	"Render CI log groups lazily",
	"Let the walkthrough agent read files outside the diff",
	"Fix tab strip jitter when a PR title wraps",
	"Remember the last chat model per harness",
	"Sync diff theme with the system appearance",
	"Add keyboard navigation between changed files",
	"Warn before merging with unpushed local commits",
	"Debounce the PR search palette",
	"Index open PRs in memory for deep-link resolution",
	"Gate the walkthrough tab behind a setting",
	"Prevent duplicate worktrees for the same PR",
	"Move code navigation to the TypeScript native language server",
	"Cache harness model discovery between launches",
	"Fix stale Refresh button after a push",
	"Show an inline error when gh is not authenticated",
	"Teach the diff pane to wrap long lines",
	"Open the file in the preferred editor from the header",
	"Hide reviewed files from the sidebar on request",
	"Batch file content reads for large PRs",
	"Respect LOG_LEVEL in the CLI",
	"Rotate the sidecar log file at 5 MB",
	"Add a stack badge for stacked pull requests",
	"Handle renamed files when restoring reviewed state",
	"Use a hand-written migration for the sessions table",
	"Fall back to the default branch when origin has no HEAD",
	"Bundle the updater into the status pill",
	"Report worktree relocation instead of failing the session",
	"Make notification permission prompts explicit",
	"Avoid re-fetching the base on every tab focus",
	"Skip lockfiles in the walkthrough coverage check",
	"Align the settings sidebar with the app sidebar",
	"Clean up the deep link queue on cold launch",
	"Document the dev sandbox data directory",
];

const STATE_CYCLE: readonly RepositorySession["state"][] = [
	{ kind: "resolved", state: "open" },
	{ kind: "resolved", state: "open" },
	{ kind: "resolved", state: "merged" },
	{ kind: "resolved", state: "merged" },
	{ kind: "resolved", state: "closed" },
	{ kind: "resolved", state: "merged" },
	{ kind: "resolved", state: "merged" },
	{ kind: "resolved", state: "merged" },
];

/** Newest first, ages growing from hours to months so every relative-time unit shows up. */
export function makeSessions(
	count: number,
	now: number,
): readonly RepositorySession[] {
	return Array.from({ length: count }, (_, index) => {
		const number = 151 - index;
		const age = (index + 1) ** 2 * 0.9 * HOUR + index * HOUR;
		return {
			id: `session-${number}`,
			prNumber: number,
			prTitle: TITLES[index % TITLES.length] ?? "Untitled change",
			state: STATE_CYCLE[index % STATE_CYCLE.length] ?? STATE_CYCLE[0],
			updatedAt: now - Math.min(age, 400 * DAY),
		} satisfies RepositorySession;
	});
}

export function nisiDetail(
	overrides: Partial<RepositoryDetail> = {},
): RepositoryDetail {
	return {
		owner: "fdarian",
		repo: "nisi",
		path: codePath("fdarian/nisi"),
		remoteUrl: "git@github.com:fdarian/nisi.git",
		problem: null,
		sessions: makeSessions(50, Date.now()),
		...overrides,
	};
}

/**
 * `get`'s answer when every `every`-th session (from `offset`) is still
 * pending, plus what `sessionStates` will later report for exactly those —
 * each PR's real state from `sessions`, one resolution per PR number.
 */
export function withPendingStates(
	sessions: readonly RepositorySession[],
	every: number,
	offset = 1,
): {
	sessions: readonly RepositorySession[];
	resolutions: RepositorySessionStateBatch;
} {
	const resolutions: RepositorySessionStateBatch[number][] = [];
	const listed = sessions.map((session, index) => {
		if (index % every !== offset || session.state.kind !== "resolved")
			return session;
		resolutions.push({ prNumber: session.prNumber, state: session.state });
		return { ...session, state: { kind: "pending" as const } };
	});
	return { sessions: listed, resolutions };
}
