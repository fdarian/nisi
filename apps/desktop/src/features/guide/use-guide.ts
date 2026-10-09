import type { GuideResult } from "@repo/sidecar-api";
import { useQuery } from "@tanstack/react-query";
import type { SidecarQueryUtils } from "#/infra/backend-context";

const ACTIVE_POLL_MS = 2000;
const BACKGROUND_POLL_MS = 5000;

/**
 * `guide.get` for a session. `PrView` calls this to decide whether the Guide
 * tab exists and `GuideView` to render it; both land on the same query key,
 * so there is one cache entry and one poll (react-query runs the shortest
 * interval among observers). Polls even while the tab isn't visible, because
 * an agent can publish a guide mid-session and the tab has to appear on its
 * own.
 */
export function useGuide(
	orpc: SidecarQueryUtils,
	sessionId: string,
	active: boolean,
) {
	return useQuery({
		...orpc.guide.get.queryOptions({ input: { sessionId } }),
		refetchInterval: active ? ACTIVE_POLL_MS : BACKGROUND_POLL_MS,
	});
}

/** An `error` result still counts: the author needs the tab to see the build error. */
export function guideExists(result: GuideResult | undefined): boolean {
	return result !== undefined && result.kind !== "missing";
}
