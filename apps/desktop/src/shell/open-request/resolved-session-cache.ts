import type { Session } from "@repo/sidecar-api";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

export function seedResolvedSession(
	queryClient: QueryClient,
	key: QueryKey,
	session: Session,
): void {
	// An older list response must not overwrite the just-resolved session.
	void queryClient.cancelQueries({ queryKey: key, exact: true });
	queryClient.setQueryData<readonly Session[]>(key, (current) => {
		if (current === undefined) return [session];
		if (!current.some((entry) => entry.id === session.id))
			return [...current, session];
		return current.map((entry) => (entry.id === session.id ? session : entry));
	});
}
