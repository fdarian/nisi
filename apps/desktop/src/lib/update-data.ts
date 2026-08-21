/**
 * macOS-only, Homebrew-cask-only self update — mirrors `UpdateState` and the
 * `update.*` procedures in `packages/sidecar-api/src/update.ts`, same as
 * every other `lib/*.ts` file redeclares its own slice of the wire contract
 * locally instead of importing it (`walkthrough-data.ts`'s `HarnessInfo`,
 * `settings-data.ts`'s `Settings`).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";

export type UpdateState =
	| { type: "unsupported" }
	| { type: "idle" }
	| { type: "available"; version: string }
	| { type: "downloading"; version: string }
	| { type: "ready"; version: string }
	| { type: "failed"; version: string; message: string };

/**
 * `update.status`, polled at a cadence that tracks how fast the state can
 * actually change: ~1s while a `brew fetch` is in flight (`downloading`), so
 * the pill's spinner-to-"Restart to update" handoff feels immediate, ~15s
 * otherwise. The handler is a free in-memory `Ref` read on the sidecar side
 * — the expensive tap-file network check runs on its own hourly background
 * fiber, not on this poll — so a short interval here costs nothing extra.
 * Defaults to `unsupported` for the gap between mount and the first
 * response, same reasoning as `settings-data.ts`'s `DEFAULT_SETTINGS`: the
 * pill renders nothing either way, so there's no flash of a wrong state.
 */
export function useUpdateStatus(orpc: SidecarQueryUtils): UpdateState {
	const query = useQuery({
		...orpc.update.status.queryOptions(),
		refetchInterval: (query) =>
			query.state.data?.type === "downloading" ? 1000 : 15000,
	});
	return query.data ?? { type: "unsupported" };
}

/**
 * `update.download` — starts (or retries) fetching the update `available`/
 * `failed` is currently offering. `mutationFn` calls `.call()` directly
 * rather than going through `.mutationOptions()`, same as
 * `walkthrough-data.ts`'s `useHarnesses().refresh` — neither procedure takes
 * an input. The mutation itself resolves as soon as the sidecar forks the
 * `brew fetch`, so the only thing left to do on success is invalidate
 * `status` — otherwise the pill would sit on `available` for up to ~15s
 * (the idle poll interval) before noticing the fetch actually started.
 */
export function useDownloadUpdate(orpc: SidecarQueryUtils): () => void {
	const queryClient = useQueryClient();
	const mutation = useMutation({
		mutationFn: () => orpc.update.download.call(),
		onSuccess: () => {
			queryClient.invalidateQueries({
				queryKey: orpc.update.status.key(),
			});
		},
	});

	return useCallback(() => mutation.mutate(), [mutation]);
}

/**
 * `update.restart` — writes and spawns the detached restart helper, which
 * waits for this app to quit before running `brew upgrade`. Returns the
 * mutation's promise (rather than firing it itself) so the caller can quit
 * the app via the `process` plugin's `exit(0)` only *after* the helper is
 * confirmed spawned — the backend contract's own ordering note.
 */
export function useRestartToUpdate(
	orpc: SidecarQueryUtils,
): () => Promise<void> {
	const mutation = useMutation({
		mutationFn: () => orpc.update.restart.call(),
	});
	return useCallback(() => mutation.mutateAsync(), [mutation]);
}
