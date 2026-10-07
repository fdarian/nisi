import { expect, spyOn, test } from "bun:test";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { DEFAULT_SETTINGS } from "@repo/settings";
import { makeSidecarClient } from "@repo/sidecar-api";
import { QueryClient } from "@tanstack/react-query";
import { prefetchResolvedFiles } from "./resolved-files";

test("cached settings start metadata prefetch synchronously with the same includeUncommitted key", async () => {
	const client = new QueryClient();
	const orpc = createTanstackQueryUtils(
		makeSidecarClient({ port: 1, token: "test" }),
	);
	client.setQueryData(orpc.settings.get.queryKey(), {
		...DEFAULT_SETTINGS,
		includeUncommitted: true,
	});
	const fetching = spyOn(client, "prefetchQuery").mockResolvedValue(undefined);
	try {
		const pending = prefetchResolvedFiles(client, orpc, "new-session");
		expect(fetching).toHaveBeenCalledTimes(1);
		expect(fetching.mock.calls[0]?.[0].queryKey).toEqual(
			orpc.diff.files.queryKey({
				input: { sessionId: "new-session", includeUncommitted: true },
			}),
		);
		await pending;
	} finally {
		fetching.mockRestore();
		client.clear();
	}
});
