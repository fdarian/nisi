import type {
	RepositoryProblem,
	RepositorySession,
	RepositorySessionListedState,
	RepositorySessionResolution,
	RepositorySessionStateBatch,
	RepositorySummary,
} from "@repo/sidecar-api";

export type SessionTab = "all" | "open" | "merged" | "closed";

export const SESSION_TABS: readonly { value: SessionTab; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "open", label: "Open" },
	{ value: "merged", label: "Merged" },
	{ value: "closed", label: "Closed" },
];

/** How many sessions the detail page shows before "Show N more". */
export const INITIAL_SESSION_COUNT = 7;

export function tildePath(path: string, home: string | undefined): string {
	if (home === undefined) return path;
	const base = home.replace(/\/+$/, "");
	if (path === base) return "~";
	return path.startsWith(`${base}/`) ? `~${path.slice(base.length)}` : path;
}

/** `github.com/owner/repo` out of any git remote URL form; a URL that isn't one is returned as-is. */
export function formatRemote(remoteUrl: string): string {
	const scp = /^[^@/]+@([^:/]+):(.+)$/.exec(remoteUrl);
	const location =
		scp === null
			? remoteUrl.replace(/^[a-z+]+:\/\/(?:[^@/]+@)?/i, "")
			: `${scp[1]}/${scp[2]}`;
	return location.replace(/\.git\/?$/, "").replace(/\/+$/, "");
}

export function problemLabel(problem: RepositoryProblem): string {
	switch (problem) {
		case "no-path":
			return "No local checkout";
		case "path-missing":
			return "Folder not found";
		case "not-a-git-repo":
			return "Not a git repository";
		case "no-origin":
			return "No origin remote";
		case "origin-mismatch":
			return "Wrong repository";
	}
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export function sessionSummary(repository: RepositorySummary): string {
	if (repository.sessionCount === 0) return "No sessions";
	const sessions = plural(repository.sessionCount, "session");
	return repository.openCount === 0
		? sessions
		: `${repository.openCount} open · ${sessions}`;
}

export function filterRepositories(
	repositories: readonly RepositorySummary[],
	query: string,
): readonly RepositorySummary[] {
	const needle = query.trim().toLowerCase();
	if (needle === "") return repositories;
	return repositories.filter((repository) =>
		`${repository.owner}/${repository.repo} ${repository.path ?? ""}`
			.toLowerCase()
			.includes(needle),
	);
}

/** A listed session's state once the stream has had its say: what `get` knew, what `sessionStates` found, or why it couldn't. */
export type SessionRowState =
	| RepositorySessionListedState
	| Extract<RepositorySessionResolution, { kind: "unresolved" }>;

export type SessionRow = Omit<RepositorySession, "state"> & {
	readonly state: SessionRowState;
};

/**
 * Fills each `pending` session in from the `sessionStates` events received so
 * far; a later event for the same PR wins, and every session of that PR gets
 * it. A session `get` already resolved is never overridden. `streamFailure`
 * is why the stream stopped early, if it did: whatever is still pending then
 * will never resolve, so it is reported as unresolved rather than left
 * looking like it is loading.
 */
export function mergeSessionStates(
	sessions: readonly RepositorySession[],
	batches: readonly RepositorySessionStateBatch[],
	streamFailure: string | null,
): readonly SessionRow[] {
	const streamed = new Map<number, RepositorySessionResolution>();
	for (const batch of batches)
		for (const update of batch) streamed.set(update.prNumber, update.state);
	return sessions.map((session): SessionRow => {
		if (session.state.kind !== "pending")
			return { ...session, state: session.state };
		const found = streamed.get(session.prNumber);
		if (found !== undefined) return { ...session, state: found };
		return streamFailure === null
			? { ...session, state: session.state }
			: { ...session, state: { kind: "unresolved", reason: streamFailure } };
	});
}

export function countPending(sessions: readonly SessionRow[]): number {
	return sessions.filter((session) => session.state.kind === "pending").length;
}

export function filterSessions(
	sessions: readonly SessionRow[],
	tab: SessionTab,
	query: string,
): readonly SessionRow[] {
	const needle = query.trim().toLowerCase().replace(/^#/, "");
	return sessions.filter(
		(session) =>
			(tab === "all" ||
				(session.state.kind === "resolved" && session.state.state === tab)) &&
			(needle === "" ||
				session.prTitle.toLowerCase().includes(needle) ||
				String(session.prNumber).includes(needle)),
	);
}

export function splitVisibleSessions(
	sessions: readonly SessionRow[],
	expanded: boolean,
): { shown: readonly SessionRow[]; hiddenCount: number } {
	if (expanded || sessions.length <= INITIAL_SESSION_COUNT)
		return { shown: sessions, hiddenCount: 0 };
	return {
		shown: sessions.slice(0, INITIAL_SESSION_COUNT),
		hiddenCount: sessions.length - INITIAL_SESSION_COUNT,
	};
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact age like `5m`, `2h`, `3d`, `6w`, `4mo`, `2y`. */
export function relativeTime(timestamp: number, now: number): string {
	const elapsed = Math.max(0, now - timestamp);
	if (elapsed < MINUTE) return "now";
	if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
	if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
	if (elapsed < 7 * DAY) return `${Math.floor(elapsed / DAY)}d`;
	if (elapsed < 30 * DAY) return `${Math.floor(elapsed / (7 * DAY))}w`;
	if (elapsed < 365 * DAY) return `${Math.floor(elapsed / (30 * DAY))}mo`;
	return `${Math.floor(elapsed / (365 * DAY))}y`;
}
