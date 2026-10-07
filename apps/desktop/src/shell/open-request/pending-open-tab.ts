import type { OpenRequest, Session } from "@repo/sidecar-api";
import {
	findOpenPullRequestSessionId,
	type OpenPullRequestParams,
} from "#/features/pull-request/data/pull-requests-data";
import { useOpenRequest } from "./open-request-data";

export type PendingOpenTab = {
	/** Stable per open; `pendingOpenTabValue` turns it into the tab's value. */
	id: string;
	label: string;
	status: "opening" | "failed";
	failure?: { title: string; message: string; dismiss: () => void };
};

export function pendingOpenTabValue(tab: PendingOpenTab): string {
	return `open:${tab.id}`;
}

function deepLinkOpenId(params: OpenPullRequestParams): string {
	return `${params.owner}/${params.repo}#${params.number}`;
}

function fromRequest(
	request: OpenRequest,
	dismiss: (id: string) => void,
): PendingOpenTab | null {
	switch (request.status.kind) {
		case "opened":
			return null;
		case "pending":
			return { id: request.id, label: "Opening…", status: "opening" };
		case "failed":
			return {
				id: request.id,
				label: "Open failed",
				status: "failed",
				failure: {
					title: `Couldn’t open ${request.cwd}`,
					message: request.status.message,
					dismiss: () => dismiss(request.id),
				},
			};
	}
}

/**
 * One placeholder at a time. An in-flight open beats a failed CLI request that
 * is still waiting to be dismissed, so a fresh deep link isn't hidden behind it.
 *
 * A deep link whose PR already has a session shows no placeholder: either the
 * PR was open before the link arrived, or `useOpenPullRequest` seeded the
 * session into the list before the mutation settled. Both mean the real tab
 * exists and must not be shown next to a placeholder.
 */
export function derivePendingOpenTab(input: {
	request: OpenRequest | null;
	dismissRequest: (id: string) => void;
	deepLink: OpenPullRequestParams | null;
	sessions: readonly Session[];
}): PendingOpenTab | null {
	const fromCli =
		input.request === null
			? null
			: fromRequest(input.request, input.dismissRequest);
	if (fromCli?.status === "opening") return fromCli;

	if (
		input.deepLink !== null &&
		findOpenPullRequestSessionId(input.sessions, input.deepLink) === undefined
	) {
		return {
			id: deepLinkOpenId(input.deepLink),
			label: `#${input.deepLink.number} ${input.deepLink.owner}/${input.deepLink.repo}`,
			status: "opening",
		};
	}
	return fromCli;
}

export function usePendingOpenTab(input: {
	deepLink: OpenPullRequestParams | null;
	sessions: readonly Session[];
}): PendingOpenTab | null {
	const open = useOpenRequest();
	return derivePendingOpenTab({
		request: open.request,
		dismissRequest: open.acknowledge,
		deepLink: input.deepLink,
		sessions: input.sessions,
	});
}
