"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";

/**
 * How long a PR tab sits inactive (not the selected tab in the multi-PR
 * strip) before it suspends — see `useTabSuspension`. A named constant, not
 * a Settings toggle, for this first pass.
 */
const TAB_SUSPEND_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * How often a tab that's blocked from suspending by an in-flight walkthrough
 * generation re-checks whether that generation has finished, instead of
 * waiting out the full `TAB_SUSPEND_TIMEOUT_MS` again — short enough that
 * the tab suspends promptly once it's safe to.
 */
const GENERATION_RECHECK_MS = 30 * 1000;

function withoutMember(
	ids: ReadonlySet<string>,
	id: string,
): ReadonlySet<string> {
	if (!ids.has(id)) return ids;
	const next = new Set(ids);
	next.delete(id);
	return next;
}

function withMember(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
	if (ids.has(id)) return ids;
	const next = new Set(ids);
	next.add(id);
	return next;
}

/**
 * Tracks which open PR tabs have gone idle long enough to suspend —
 * `app-shell.tsx` reads `suspendedSessionIds` back to decide whether to
 * render each session's `PrView` at all (dropping `keepMounted` for a
 * suspended one), and this hook owns everything behind that: the per-session
 * idle timers, and the actual suspend side effect of evicting that session's
 * `diff.fileContents` query-cache entries so memory frees immediately
 * instead of waiting out TanStack's own `gcTime`.
 *
 * The active tab (`activeSessionId`) never suspends, and neither does a tab
 * with a walkthrough generation currently running for it — that generation
 * is reattachable server-side, but the live turn-by-turn progress log
 * (`useWalkthroughGeneration`'s `history`) is client-only state that
 * unmounting would lose. That hook's own component (`WalkthroughView`)
 * already unmounts whenever the Walkthrough sub-tab isn't the one showing
 * (Base UI's `TabsPanel` defaults to `keepMounted={false}`), even while the
 * PR tab itself stays selected — so there's no live client flag to read here
 * either way, active tab or not. This checks the sidecar directly via
 * `walkthrough.activeGeneration` instead, right before actually suspending,
 * and reschedules a shorter recheck (`GENERATION_RECHECK_MS`) rather than
 * suspending, whenever that check reports `"running"`.
 */
export type TabSuspensionControls = {
	suspendedSessionIds: ReadonlySet<string>;
	/**
	 * Suspends a tab immediately, bypassing `TAB_SUSPEND_TIMEOUT_MS` — the
	 * context menu's "Suspend" item calls this directly rather than
	 * duplicating `checkAndSuspend`'s walkthrough-generation guard or the
	 * cache-eviction effect it triggers below. `checkAndSuspend` itself
	 * cancels whatever timer (idle countdown or generation recheck) is
	 * already pending for this session, so that timer can't also fire a
	 * second, redundant check later.
	 */
	suspendNow: (sessionId: string) => void;
	/**
	 * One-shot check of whether a session currently has a walkthrough
	 * generation running — same fallback-to-`false`-on-error behavior as
	 * `checkAndSuspend`'s own guard, exposed so the context menu can decide
	 * up front whether to disable "Suspend" and explain why, instead of the
	 * user only finding out after the click did nothing.
	 */
	isGenerationRunning: (sessionId: string) => Promise<boolean>;
};

export function useTabSuspension(
	sessions: readonly Session[],
	activeSessionId: string | null,
	orpc: SidecarQueryUtils,
): TabSuspensionControls {
	const queryClient = useQueryClient();
	const [suspendedSessionIds, setSuspendedSessionIds] = useState<
		ReadonlySet<string>
	>(() => new Set());
	const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
	const activeSessionIdRef = useRef(activeSessionId);
	const orpcRef = useRef(orpc);
	const previouslySuspendedRef = useRef<ReadonlySet<string>>(new Set());

	activeSessionIdRef.current = activeSessionId;
	orpcRef.current = orpc;

	// Same fallback `useWalkthroughGeneration` uses for this call — an
	// unreachable/erroring check is treated as "nothing running". Shared by
	// `checkAndSuspend`'s own guard and by `isGenerationRunning` below so
	// neither has to restate it.
	const isGenerationRunning = useCallback(async (sessionId: string) => {
		const activeGeneration = await orpcRef.current.walkthrough.activeGeneration
			.call({ sessionId })
			.catch(() => null);
		return activeGeneration?.status === "running";
	}, []);

	// Self-contained with respect to `timers`: clears whatever timer is
	// already pending for `sessionId` (an idle countdown from
	// `scheduleSuspend`, or its own previous generation-recheck reschedule)
	// before doing anything else, so every caller — the idle timeout, the
	// recheck timeout, and `suspendNow`'s manual trigger below — can call
	// this directly without first tearing down `timers.current` itself. That
	// matters most for `suspendNow`: without this, a manual call racing an
	// already-pending idle timer would have this function's own
	// `timers.current.set` below silently overwrite (not clear) that timer,
	// leaking it to fire again later.
	const checkAndSuspend = useCallback(
		(sessionId: string) => {
			const pendingTimer = timers.current.get(sessionId);
			if (pendingTimer !== undefined) {
				clearTimeout(pendingTimer);
				timers.current.delete(sessionId);
			}

			void (async () => {
				const running = await isGenerationRunning(sessionId);

				// The tab may have become the active one, or closed outright, while
				// the check above was in flight.
				if (activeSessionIdRef.current === sessionId) return;

				if (running) {
					const timer = setTimeout(() => {
						timers.current.delete(sessionId);
						checkAndSuspend(sessionId);
					}, GENERATION_RECHECK_MS);
					timers.current.set(sessionId, timer);
					return;
				}

				setSuspendedSessionIds((current) => withMember(current, sessionId));
			})();
		},
		[isGenerationRunning],
	);

	// `checkAndSuspend` already clears its own pending timer and applies the
	// generation guard, so the manual trigger exposed to callers is just that
	// function under a name that reads right at the call site.
	const suspendNow = checkAndSuspend;

	const scheduleSuspend = useCallback(
		(sessionId: string) => {
			if (timers.current.has(sessionId)) return;
			const timer = setTimeout(() => {
				timers.current.delete(sessionId);
				checkAndSuspend(sessionId);
			}, TAB_SUSPEND_TIMEOUT_MS);
			timers.current.set(sessionId, timer);
		},
		[checkAndSuspend],
	);

	// Owns the idle timers: the active tab is resumed and its timer
	// cancelled, every other open tab gets one scheduled (unless it's already
	// suspended or already has one running), and a closed tab's timer is
	// torn down along with any suspended flag it was holding. Idempotent by
	// construction (`scheduleSuspend` no-ops when a timer already exists), so
	// re-running this on every `sessions`/`suspendedSessionIds` change — e.g.
	// an unrelated query refetch producing a new `sessions` array — never
	// restarts a countdown already in progress.
	useEffect(() => {
		const openSessionIds = new Set(sessions.map((session) => session.id));

		if (activeSessionId !== null) {
			const timer = timers.current.get(activeSessionId);
			if (timer !== undefined) {
				clearTimeout(timer);
				timers.current.delete(activeSessionId);
			}
			setSuspendedSessionIds((current) =>
				withoutMember(current, activeSessionId),
			);
		}

		for (const session of sessions) {
			if (session.id === activeSessionId) continue;
			if (suspendedSessionIds.has(session.id)) continue;
			scheduleSuspend(session.id);
		}

		for (const [sessionId, timer] of timers.current) {
			if (!openSessionIds.has(sessionId)) {
				clearTimeout(timer);
				timers.current.delete(sessionId);
			}
		}
		setSuspendedSessionIds((current) => {
			let next: Set<string> | undefined;
			for (const sessionId of current) {
				if (!openSessionIds.has(sessionId)) {
					next ??= new Set(current);
					next.delete(sessionId);
				}
			}
			return next ?? current;
		});
	}, [sessions, activeSessionId, suspendedSessionIds, scheduleSuspend]);

	// Every timer this hook owns is only meaningful for as long as
	// `AppShellReady` itself is mounted.
	useEffect(() => {
		const timerMap = timers.current;
		return () => {
			for (const timer of timerMap.values()) clearTimeout(timer);
			timerMap.clear();
		};
	}, []);

	// Evicts a newly-suspended session's `diff.fileContents` cache entries —
	// deliberately in an effect, not inline where `suspendedSessionIds` gets
	// its new member above, so this only ever runs after the render that
	// stops mounting that session's `PrView` has actually committed (React
	// guarantees effects run post-commit): the query's own observer
	// (`useFileContents` inside the now-unmounted `DiffPane`) is gone before
	// its cache entries are.
	useEffect(() => {
		for (const sessionId of suspendedSessionIds) {
			if (!previouslySuspendedRef.current.has(sessionId)) {
				queryClient.removeQueries({
					queryKey: orpc.diff.fileContents.key({ input: { sessionId } }),
				});
			}
		}
		previouslySuspendedRef.current = suspendedSessionIds;
	}, [suspendedSessionIds, queryClient, orpc]);

	return { suspendedSessionIds, suspendNow, isGenerationRunning };
}
