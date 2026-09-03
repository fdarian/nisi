/**
 * `codeIndex.status`/`codeIndex.build` — the read/act split
 * `packages/sidecar-api/src/code-index.ts`'s own doc comment describes
 * (mirrors `walkthrough.activeGeneration`/`walkthrough.generate`). Building
 * is never triggered automatically; a caller only ever sees a value here by
 * fetching it (on mount, or via `refetch`), and only ever starts a build by
 * calling `build()` itself — the peek panel's "Build index" action.
 *
 * `useQuery`'s own cache dedupes this across every consumer sharing one
 * `sessionId` (every open file tab, plus the diff pane, each call this) —
 * so "fetch it once per session" falls out of TanStack Query's normal
 * subscription sharing rather than needing its own singleton.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";

/** While a build is in flight, `status` is polled once a second so the peek's spinner/"Building…" state stays live; otherwise it's a plain one-shot fetch. */
const BUILD_POLL_INTERVAL_MS = 1000;

export function useCodeIndexStatus(orpc: SidecarQueryUtils, sessionId: string) {
	const queryClient = useQueryClient();
	const queryOptions = orpc.codeIndex.status.queryOptions({
		input: { sessionId },
	});
	const statusQuery = useQuery({
		...queryOptions,
		refetchInterval: (query) =>
			query.state.data?.status === "building" ? BUILD_POLL_INTERVAL_MS : false,
	});

	const buildMutation = useMutation(orpc.codeIndex.build.mutationOptions());
	const build = useCallback(() => {
		buildMutation.mutate(
			{ sessionId },
			{
				onSettled: () => {
					queryClient.invalidateQueries({ queryKey: queryOptions.queryKey });
				},
			},
		);
	}, [buildMutation, sessionId, queryClient, queryOptions.queryKey]);

	return {
		status: statusQuery.data,
		isLoading: statusQuery.isLoading,
		build,
		isBuildStarting: buildMutation.isPending,
	};
}
