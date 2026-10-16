import { createORPCClient } from "@orpc/client";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { SidecarClient } from "@repo/sidecar-api";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { defaultShouldDehydrateQuery, hashKey } from "@tanstack/react-query";
import type { PersistQueryClientProviderProps } from "@tanstack/react-query-persist-client";
import { RECENT_PULL_REQUESTS_INPUT } from "#/features/pull-request/data/pull-requests-data";

// Key generation never invokes the client, so the real one (which only exists
// once the backend resolves) isn't needed — and calling this one is a bug.
const keyOnlyClient = createORPCClient<SidecarClient>({
	call: () => {
		throw new Error("query-persistence's key-only client must never be called");
	},
});

const recentPullRequestsKeyHash = hashKey(
	createTanstackQueryUtils(keyOnlyClient).pullRequests.search.queryKey({
		input: RECENT_PULL_REQUESTS_INPUT,
	}),
);

/** Persists only the ⌘T palette's blank-query recent-PR list; everything else stays in memory. */
export const persistOptions: PersistQueryClientProviderProps["persistOptions"] =
	{
		persister: createSyncStoragePersister({
			storage: window.localStorage,
			key: "nisi:query-cache",
		}),
		maxAge: 24 * 60 * 60 * 1000,
		buster: __APP_VERSION__,
		dehydrateOptions: {
			shouldDehydrateQuery: (query) =>
				defaultShouldDehydrateQuery(query) &&
				hashKey(query.queryKey) === recentPullRequestsKeyHash,
		},
	};
