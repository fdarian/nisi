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
 *
 * `enabled` (default `true`) reaches straight through to `useQuery` — the
 * SCIP code-navigation feature is opt-in per session
 * (`useSessionCodeIndexEnabled`), and disabled means disabled: no request at
 * all, not even this one-shot status read, while the toggle is off.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";

/** While a build is in flight, `status` is polled once a second so the peek's spinner/"Building…" state stays live; otherwise it's a plain one-shot fetch. */
const BUILD_POLL_INTERVAL_MS = 1000;

export function useCodeIndexStatus(
	orpc: SidecarQueryUtils,
	sessionId: string,
	enabled = true,
) {
	const queryClient = useQueryClient();
	const queryOptions = orpc.codeIndex.status.queryOptions({
		input: { sessionId },
	});
	const statusQuery = useQuery({
		...queryOptions,
		enabled,
		refetchInterval: (query) =>
			query.state.data?.status === "building" ? BUILD_POLL_INTERVAL_MS : false,
	});

	const buildMutation = useMutation(orpc.codeIndex.build.mutationOptions());
	const build = useCallback(() => {
		buildMutation.mutate(
			{ sessionId },
			{
				onError: (error) => {
					// A rejected `build` call (session gone, repo unsupported) is
					// distinct from the sidecar recording a `"failed"` *status* after
					// a build actually started and errored — `status`'s own
					// `failureMessage` covers that case already (rendered by
					// `IndexStatusBanner`), so this only needs to cover the call
					// itself never having started.
					toastManager.add({
						title: "Couldn't start building the code index",
						description: error instanceof Error ? error.message : String(error),
						type: "error",
					});
				},
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
