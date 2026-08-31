/**
 * Drains `deep-link-store.ts`'s pending queue into real PR sessions, plus
 * the route redirect that gets a link out of `/settings` and back where
 * `AppShellReady` can see it. Same explicit-`orpc`-param idiom as
 * `#/lib/pr-data.ts`.
 */
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useSyncExternalStore } from "react";
import { toastManager } from "#/components/ui/toast";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { parseNisiDeepLink } from "#/lib/deep-link";
import {
	dequeueDeepLink,
	getPendingDeepLinksSnapshot,
	subscribeToDeepLinks,
} from "#/lib/deep-link-store";
import {
	friendlyOpenPullRequestError,
	useOpenPullRequest,
} from "#/lib/pull-requests-data";

/**
 * Opens whatever's pending in `deep-link-store.ts`, one at a time — gated
 * on `useOpenPullRequest`'s own `isPending` so two links landing close
 * together can't race two native folder pickers. Reuses
 * `useOpenPullRequest` rather than the module-private
 * `resolvePullRequestOpen` (`pull-requests-data.ts`) since that hook
 * already wraps the folder-picker detour, cancel-is-not-an-error, and
 * `friendlyOpenPullRequestError` — a parallel open path here would just
 * re-derive all of that.
 *
 * Call once, from `AppShellReady` (mounted only on `/`, the only route
 * that can render an opened PR's tab). Doesn't need an "already open"
 * check: `reviewStore.openSession` dedupes on `computeSessionKey`, and the
 * `session-opened` event `useSessions` already subscribes to activates
 * (and, on `isTauri()`, refocuses) the existing tab — a repeat link
 * re-focuses rather than duplicating.
 */
export function useDeepLinkOpener(
	orpc: SidecarQueryUtils,
	onOpened: (sessionId: string) => void,
): void {
	const pending = useSyncExternalStore(
		subscribeToDeepLinks,
		getPendingDeepLinksSnapshot,
	);
	const openPr = useOpenPullRequest(orpc, onOpened);

	useEffect(() => {
		if (openPr.isPending) return;
		if (pending.length === 0) return;

		const url = dequeueDeepLink();
		if (url === undefined) return;

		const parsed = parseNisiDeepLink(url);
		if (parsed === null) {
			// Not actionable — a malformed or non-PR nisi link — see the plan's
			// "Negative" verification case. Dropped with a toast rather than
			// silently, since something did try to hand this app a link.
			toastManager.add({
				title: "Couldn't open that link",
				description: `"${url}" isn't a recognized nisi link.`,
				type: "error",
			});
			return;
		}

		openPr.open(parsed.pullRequest);
		// `openPr.open` is a fresh closure every render (`useOpenPullRequest`
		// doesn't wrap it in `useCallback`), so it's a real dependency here but
		// not a meaningful trigger — the guards above (`isPending`,
		// `pending.length`) are what actually gate the work, so an extra
		// re-run from `open` alone just no-ops.
	}, [pending, openPr.isPending, openPr.open]);

	useEffect(() => {
		if (openPr.error === null || openPr.error === undefined) return;
		toastManager.add({
			title: "Couldn't open that pull request",
			description: friendlyOpenPullRequestError(openPr.error),
			type: "error",
		});
		openPr.reset();
	}, [openPr.error, openPr.reset]);
}

/**
 * Bounces back to `/` the moment a deep link arrives while `/settings` is
 * showing. `/` and `/settings` are sibling routes under one `<Outlet/>`
 * (`routes/__root.tsx`) — navigating between them unmounts one and mounts
 * the other, so `AppShellReady` (which only renders on `/`) can't see a
 * link that arrives while `/settings` is active. This is the piece that
 * can, since it needs no `orpc` and can live somewhere always mounted
 * (`RootLayout`). Doesn't drain the queue itself — once the navigate
 * lands, `AppShellReady` mounts and `useDeepLinkOpener` takes it from
 * there.
 */
export function useRedirectHomeOnPendingDeepLink(): void {
	const hasPending = useSyncExternalStore(
		subscribeToDeepLinks,
		() => getPendingDeepLinksSnapshot().length > 0,
	);
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const navigate = useNavigate();

	useEffect(() => {
		if (!hasPending) return;
		if (pathname !== "/settings") return;
		navigate({ to: "/" });
	}, [hasPending, pathname, navigate]);
}
