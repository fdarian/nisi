import type { GuideResult } from "@repo/sidecar-api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useSidecarEvent } from "#/infra/sidecar-events";

/**
 * `guide.get` for a session. `PrView` calls this to decide whether the Guide
 * tab exists and `GuideView` to render it; both land on the same query key,
 * so there is one cache entry. It is never polled: the sidecar sends
 * `guide-changed` when the guide folder or the session's head moves (see
 * `useGuideWatch`), and a `session-diff-source-changed` correction changes the
 * diff the guide is checked against.
 */
export function useGuide(orpc: SidecarQueryUtils, sessionId: string) {
	const queryClient = useQueryClient();
	useSidecarEvent((event) => {
		const stale =
			(event.type === "guide-changed" ||
				event.type === "session-diff-source-changed") &&
			event.sessionId === sessionId;
		if (!stale) return;
		// `PrView` and `GuideView` both listen; the second invalidation must not
		// cancel the refetch the first one started.
		void queryClient.invalidateQueries(
			{ queryKey: orpc.guide.get.key({ input: { sessionId } }) },
			{ cancelRefetch: false },
		);
	});
	return useQuery(orpc.guide.get.queryOptions({ input: { sessionId } }));
}

/**
 * Asks the sidecar for `guide-changed` events while `watched`. The sidecar
 * forgets the registration when it restarts (a dev reload), so the watch is
 * re-sent whenever the event stream reconnects. Every (re)start also refetches
 * the guide, since whatever changed in between produced no event.
 */
export function useGuideWatch(
	orpc: SidecarQueryUtils,
	sessionId: string,
	watched: boolean,
): void {
	const queryClient = useQueryClient();
	const mutation = useMutation(orpc.guide.setWatching.mutationOptions());
	const mutateRef = useRef(mutation.mutate);
	mutateRef.current = mutation.mutate;
	const refetch = () =>
		void queryClient.invalidateQueries(
			{ queryKey: orpc.guide.get.key({ input: { sessionId } }) },
			{ cancelRefetch: false },
		);
	const refetchRef = useRef(refetch);
	refetchRef.current = refetch;

	useEffect(() => {
		if (!watched) return;
		mutateRef.current(
			{ sessionId, watching: true },
			{ onSuccess: () => refetchRef.current() },
		);
		return () => mutateRef.current({ sessionId, watching: false });
	}, [sessionId, watched]);

	useSidecarEvent((event) => {
		if (event.type !== "stream-ready" || !watched) return;
		mutateRef.current(
			{ sessionId, watching: true },
			{ onSuccess: () => refetchRef.current() },
		);
	});
}

/** An `error` result still counts: the author needs the tab to see the build error. */
export function guideExists(result: GuideResult | undefined): boolean {
	return result !== undefined && result.kind !== "missing";
}
