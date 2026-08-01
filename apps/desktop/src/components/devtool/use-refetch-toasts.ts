import { matchQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useToastOnRefetch } from "#/components/devtool/dev-tool-context";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";

type WatchedQuery = {
	label: string;
	queryKey: readonly unknown[];
};

/** One toast per watched query, keyed so a later `fetch`/`success`/`error` for the same query updates it in place instead of stacking a new toast. */
const toastId = (label: string): string => `devtool-refetch-${label}`;

/**
 * Devtool instrumentation for the Files Changed queries — fires a
 * promise-style toast (pending → settled) for every *refetch* of
 * `orpc.diff.files`/`orpc.diff.fileContents` for `sessionId`, whether or not
 * the user asked for it.
 *
 * Hooked into the TanStack Query cache itself
 * (`queryClient.getQueryCache().subscribe`), not the Refresh button —
 * instrumenting the click would only ever report refetches the user already
 * initiated, and the whole point of this devtool is to surface the ones
 * nobody did. Driven off the cache's own fetch-start/fetch-settle
 * transitions (the `"fetch"` action flips `fetchStatus` to `"fetching"`;
 * `"success"`/`"error"` flip it back), matched against each watched query via
 * `matchQuery` — the same partial `queryKey`-prefix matching
 * `useSetFileViewed`/`useLiveFileChanges` (`pr-data.ts`) already rely on for
 * `invalidateQueries`, so a query that's part of any active chunk/variant of
 * `diff.files`/`diff.fileContents` for this session is picked up regardless
 * of its other input fields (`includeUncommitted`, per-chunk `paths`, …).
 *
 * `dataUpdateCount > 0` at the moment a `"fetch"` action lands is what
 * distinguishes a *refetch* from each query's own initial load — the reducer
 * that processes `"fetch"` doesn't touch `data`, so a query that has never
 * resolved still reads `dataUpdateCount === 0` at that instant. Without this
 * check, the toast would double as (an uninformative) loading indicator for
 * every file pane's first open.
 *
 * Inert — no subscription, no toasts — while the "toast on every refetch"
 * devtool option (`dev-tool.tsx`) is off.
 */
export function useRefetchToasts(
	orpc: SidecarQueryUtils,
	sessionId: string,
): void {
	const queryClient = useQueryClient();
	const [toastOnRefetch] = useToastOnRefetch();

	useEffect(() => {
		if (!toastOnRefetch) return;

		const watchedQueries: readonly WatchedQuery[] = [
			{
				label: "diff.files",
				queryKey: orpc.diff.files.key({ input: { sessionId } }),
			},
			{
				label: "diff.fileContents",
				queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
			},
		];

		return queryClient.getQueryCache().subscribe((event) => {
			if (event.type !== "updated") return;

			const watched = watchedQueries.find((query) =>
				matchQuery({ queryKey: query.queryKey }, event.query),
			);
			if (watched === undefined) return;

			const id = toastId(watched.label);

			if (event.action.type === "fetch") {
				if (event.query.state.dataUpdateCount === 0) return;
				toastManager.add({
					id,
					title: `Refetching ${watched.label}…`,
					type: "loading",
				});
				return;
			}

			if (event.action.type === "success") {
				toastManager.update(id, {
					title: `${watched.label} refetched`,
					type: "success",
				});
				return;
			}

			if (event.action.type === "error") {
				toastManager.update(id, {
					title: `${watched.label} refetch failed`,
					type: "error",
				});
			}
		});
	}, [orpc, queryClient, sessionId, toastOnRefetch]);
}
