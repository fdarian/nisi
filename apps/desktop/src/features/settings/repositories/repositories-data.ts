import { ORPCError } from "@orpc/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { homeDir } from "@tauri-apps/api/path";
import { revealItemsInDir } from "@tauri-apps/plugin-opener";
import type { SidecarQueryUtils } from "#/infra/backend-context";

export function useRepositories(orpc: SidecarQueryUtils) {
	return useQuery(orpc.repositories.list.queryOptions());
}

export function useRepository(
	orpc: SidecarQueryUtils,
	owner: string,
	repo: string,
) {
	return useQuery(
		orpc.repositories.get.queryOptions({ input: { owner, repo } }),
	);
}

/** `undefined` outside the desktop shell (browser dev, Storybook), where paths just stay absolute. */
export function useHomeDir(): string | undefined {
	return useQuery({
		queryKey: ["home-dir"],
		queryFn: homeDir,
		enabled: isTauri(),
		staleTime: Number.POSITIVE_INFINITY,
	}).data;
}

export function revealInFinder(path: string): Promise<void> {
	return revealItemsInDir(path);
}

/**
 * The native folder picker, then `pullRequests.recordRepoPath` — which
 * verifies the folder's `origin` against `owner/repo` and rejects a wrong
 * one with a message naming the mismatch. A cancelled picker resolves to
 * `"cancelled"`, not an error.
 */
export function useChangeRepositoryPath(orpc: SidecarQueryUtils) {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: async (repository: {
			owner: string;
			repo: string;
		}): Promise<"changed" | "cancelled"> => {
			const picked = await invoke<string | null>("pick_folder", {
				title: `Where is ${repository.owner}/${repository.repo} checked out?`,
			});
			if (picked === null) return "cancelled";
			await orpc.pullRequests.recordRepoPath.call({
				owner: repository.owner,
				repo: repository.repo,
				path: picked,
			});
			return "changed";
		},
		onSuccess: (outcome) => {
			if (outcome === "cancelled") return;
			queryClient.invalidateQueries({ queryKey: orpc.repositories.key() });
			queryClient.invalidateQueries({
				queryKey: orpc.pullRequests.repositories.key(),
			});
		},
	});
}

/** The sidecar writes its own message for every declared failure; anything else (sidecar down, network) gets generic copy. */
export function friendlyRepositoryError(error: unknown): string {
	if (error instanceof ORPCError && typeof error.message === "string")
		return error.message;
	if (error instanceof Error) return error.message;
	return "Couldn't reach the sidecar.";
}
