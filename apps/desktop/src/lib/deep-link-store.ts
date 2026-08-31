/**
 * Module-scope home for pending `nisi://` links. A link can
 * arrive (the plugin's `deep-link://new-url` event, from Rust's
 * `RunEvent::Opened`) before the webview exists, before React mounts, and
 * before the sidecar handshake resolves — module scope for the same reason
 * `chat-store.ts` holds `chatInstances` there: this has to outlive whatever
 * component happens to be mounted at the moment a link lands, not live
 * inside one.
 */
import { isTauri } from "@tauri-apps/api/core";
import { getCurrent, onOpenUrl } from "@tauri-apps/plugin-deep-link";

type Listener = () => void;

let pendingLinks: readonly string[] = [];
const listeners = new Set<Listener>();

function notify(): void {
	for (const listener of listeners) listener();
}

function enqueue(url: string): void {
	pendingLinks = [...pendingLinks, url];
	notify();
}

/** `useSyncExternalStore`'s subscribe half. */
export function subscribeToDeepLinks(listener: Listener): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** `useSyncExternalStore`'s snapshot half — stable by reference until the queue actually changes. */
export function getPendingDeepLinksSnapshot(): readonly string[] {
	return pendingLinks;
}

/** Pops the oldest pending link, if any — `useDeepLinkOpener` drains one at a time. */
export function dequeueDeepLink(): string | undefined {
	if (pendingLinks.length === 0) return undefined;
	const next = pendingLinks[0];
	pendingLinks = pendingLinks.slice(1);
	notify();
	return next;
}

let started = false;

/**
 * Boot-once: call exactly once, from `main.tsx`, before `createRoot`.
 * Guarded on `isTauri()` like `pr-data.ts` does, for `bun dev --browser`
 * and Storybook, where there's no deep-link plugin to talk to.
 *
 * **Attaches `onOpenUrl` before calling `getCurrent()`.** On a cold launch,
 * the plugin's `RunEvent::Opened` handler does both at once on the Rust
 * side — stores `current` *and* emits `deep-link://new-url` — so this
 * listener and `getCurrent()` can both end up observing the same launch
 * URL. Attaching the listener first means a URL that arrives in the gap
 * between plugin init and this call still reaches it instead of being
 * missed; the `receivedViaListener` set below is what then stops that same
 * URL from *also* being enqueued a second time by `getCurrent()` — without
 * it, a cold launch would enqueue (and open) the launch link twice.
 *
 * The plugin never clears `getCurrent()`'s result, so this must never run
 * again after boot — a listener re-registered inside a component (e.g. on
 * every `AppShell` remount) would replay the very first launch link
 * forever. Leave this comment if you ever touch this function.
 */
export async function startDeepLinkListener(): Promise<void> {
	if (!isTauri() || started) return;
	started = true;

	const receivedViaListener = new Set<string>();
	await onOpenUrl((urls) => {
		for (const url of urls) {
			receivedViaListener.add(url);
			enqueue(url);
		}
	});

	const current = await getCurrent();
	if (current === null) return;
	for (const url of current) {
		if (receivedViaListener.has(url)) continue;
		enqueue(url);
	}
}
