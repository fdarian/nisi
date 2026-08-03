/**
 * Pull request search + open — mirrors `packages/sidecar-api/src/pull-requests.ts`.
 * Same explicit-`orpc`-param idiom as `#/lib/pr-data.ts`.
 *
 * `search` hits GitHub live via `gh search prs` on every call — no local
 * index or cache. `useSearchPullRequests` below is the palette's only data
 * source; the debounce that keeps that live outside GitHub's rate limit
 * lives in the palette itself (`#/components/pr/open-pull-request-palette.tsx`),
 * not here, since it has to coordinate with the "reset to a blank query on
 * open" effect that already lives there.
 */
import { ORPCError } from "@orpc/client";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { open as openFolderPicker } from "@tauri-apps/plugin-dialog";
import type { SidecarQueryUtils } from "#/lib/backend-context";

/** One row the palette renders — mirrors `PullRequestSearchResult` (`packages/sidecar-api/src/pull-requests.ts`). */
export type PullRequestSearchResult = {
	owner: string;
	repo: string;
	number: number;
	title: string;
	author: string;
	updatedAt: string;
	url: string;
	isDraft: boolean;
};

/**
 * Live `gh`-backed search behind TanStack Query, keyed on `query` — a repeat
 * of a query already seen this session (retyping after a backspace, opening
 * the palette again with the same search) resolves from cache for free
 * rather than re-asking GitHub. `placeholderData: keepPreviousData` is what
 * makes this stale-while-revalidate: the list never blanks or flashes
 * between keystrokes, it just keeps showing the previous query's results
 * until the new ones land (or the query fails — see `error` below, which the
 * palette shows alongside whatever's still on screen rather than in place of
 * it).
 */
export function useSearchPullRequests(
	orpc: SidecarQueryUtils,
	query: string,
): {
	results: readonly PullRequestSearchResult[];
	isSearching: boolean;
	error: unknown;
} {
	const search = useQuery({
		...orpc.pullRequests.search.queryOptions({ input: { query } }),
		placeholderData: keepPreviousData,
	});
	return {
		results: search.data ?? [],
		isSearching: search.isFetching,
		error: search.error,
	};
}

/**
 * `search`'s three contract errors each mean something genuinely different
 * to act on — collapsing them into one "search failed" would lose that.
 * `null` for anything undeclared (network down, sidecar crash): there's no
 * server-authored message to show for those, so the caller falls back to its
 * own generic copy instead of this returning one.
 */
export function friendlySearchError(error: unknown): string | null {
	if (!(error instanceof ORPCError)) return null;
	switch (error.code) {
		case "GH_NOT_AUTHENTICATED":
			return "GitHub isn't authenticated — run `gh auth login` in a terminal, then try again.";
		case "TOO_MANY_REQUESTS":
			return "GitHub's search is rate-limited right now — wait a moment and try again.";
		case "SERVICE_UNAVAILABLE":
			return "Couldn't reach GitHub — check your network connection.";
		default:
			return null;
	}
}

export type OpenPullRequestParams = {
	owner: string;
	repo: string;
	number: number;
};

/**
 * `pullRequests.open`'s `"needs-repo-path"` outcome resolved end-to-end: the
 * native folder picker (`@tauri-apps/plugin-dialog`, already registered in
 * `src-tauri` — see `apps/desktop/AGENTS.md`), `recordRepoPath` to persist
 * and verify what the user picked, then `open` again now that the mapping
 * exists. A cancelled picker (`openFolderPicker` resolving `null`) isn't an
 * error — the user just changed their mind — so it resolves to
 * `{status: "cancelled"}` rather than throwing, keeping `useOpenPullRequest`'s
 * mutation from surfacing a spurious failure banner for it.
 *
 * `recordRepoPath` rejecting (a picked folder whose `origin` doesn't match
 * `owner/repo`) *is* a real error and is left to propagate as the `ORPCError`
 * it already is — the sidecar's message already names which repo mismatched
 * (see `apps/desktop/sidecar/http.ts`'s `recordRepoPath` handler), so there's
 * nothing to add here.
 */
async function resolvePullRequestOpen(
	orpc: SidecarQueryUtils,
	params: OpenPullRequestParams,
): Promise<{ status: "opened"; sessionId: string } | { status: "cancelled" }> {
	const outcome = await orpc.pullRequests.open.call(params);
	if (outcome.status === "opened") {
		return { status: "opened", sessionId: outcome.session.id };
	}

	const picked = await openFolderPicker({
		directory: true,
		multiple: false,
		title: `Where is ${outcome.owner}/${outcome.repo} checked out?`,
	});
	if (picked === null) return { status: "cancelled" };

	await orpc.pullRequests.recordRepoPath.call({
		owner: outcome.owner,
		repo: outcome.repo,
		path: picked,
	});

	const retried = await orpc.pullRequests.open.call(params);
	if (retried.status === "opened") {
		return { status: "opened", sessionId: retried.session.id };
	}
	// `recordRepoPath` only persists a mapping once it's verified the folder's
	// `origin` actually matches — a fresh `open` right after should always
	// resolve. Reaching here means it somehow didn't (a race with something
	// else clearing the mapping); surfaced plainly rather than silently
	// re-prompting in a loop.
	throw new Error(
		`still couldn't resolve a local checkout for ${outcome.owner}/${outcome.repo} after recording ${picked}`,
	);
}

/**
 * `pullRequests.open` — creates/reuses a worktree, then the same
 * `sessions.open` domain logic every other session goes through, by way of
 * `resolvePullRequestOpen`'s folder-picker detour when there's no known repo
 * path yet. A network fetch plus a worktree checkout (and, on the
 * first-time-per-repo path, a native dialog the user has to act on), so this
 * can take a while — the palette shows `isPending` inline and must not close
 * until it settles.
 *
 * `onOpened` is wired as the mutation's own `onSuccess` (hook-level, not a
 * per-call one passed to `.mutate()`) purely so the palette's call site stays
 * a plain `open(params)` — there's no `useMutationState` overlay elsewhere
 * reading this mutation's pending status, so unlike `useSetFileViewed`
 * (`#/lib/pr-data.ts`) there's no timing subtlety riding on the split, just
 * fewer arguments to thread through. Only fires for the `"opened"` outcome —
 * a cancelled folder picker resolves the mutation successfully but leaves
 * the palette open.
 */
export function useOpenPullRequest(
	orpc: SidecarQueryUtils,
	onOpened: (sessionId: string) => void,
): {
	open: (params: OpenPullRequestParams) => void;
	isPending: boolean;
	pendingParams: OpenPullRequestParams | undefined;
	error: unknown;
	reset: () => void;
} {
	const mutation = useMutation({
		mutationFn: (params: OpenPullRequestParams) =>
			resolvePullRequestOpen(orpc, params),
		onSuccess: (outcome) => {
			if (outcome.status === "opened") onOpened(outcome.sessionId);
		},
	});

	return {
		open: (params) => mutation.mutate(params),
		isPending: mutation.isPending,
		pendingParams: mutation.variables,
		error: mutation.error,
		reset: mutation.reset,
	};
}

/**
 * GitHub serves an account's avatar straight off its login, no API call or
 * token needed — `author` here is already that login (`PullRequestSearchResult`
 * mirrors `gh`'s `author.login`), so the palette can point an `<img>` at this
 * directly instead of carrying an avatar URL through the schema.
 */
export function githubAvatarUrl(login: string): string {
	return `https://github.com/${login}.png?size=64`;
}

/**
 * Every code `pullRequests.open`/`recordRepoPath` can fail with (see those
 * contracts' docs) maps to a message the sidecar already wrote in plain
 * English (`apps/desktop/sidecar/http.ts`'s `Effect.catchTag` chains) — this
 * just decides whether `error` is one of those (or the plain `Error`
 * `resolvePullRequestOpen` throws for its own unreachable case) versus an
 * undeclared failure (network down, sidecar crash) with no authored message
 * to show.
 */
export function friendlyOpenPullRequestError(error: unknown): string {
	if (error instanceof ORPCError && typeof error.message === "string") {
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return "Couldn't open this pull request — the sidecar may be unreachable.";
}
