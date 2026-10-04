import type { QueryClient } from "@tanstack/react-query";
import type { SidecarQueryUtils } from "#/infra/backend-context";

export async function prefetchResolvedFiles(
	queryClient: QueryClient,
	orpc: SidecarQueryUtils,
	sessionId: string,
): Promise<void> {
	const cached = queryClient.getQueryData(orpc.settings.get.queryKey());
	const settings =
		cached === undefined
			? await queryClient.ensureQueryData(orpc.settings.get.queryOptions())
			: cached;
	await queryClient.prefetchQuery(
		orpc.diff.files.queryOptions({
			input: { sessionId, includeUncommitted: settings.includeUncommitted },
		}),
	);
}
