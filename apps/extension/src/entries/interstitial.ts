/**
 * The page a direct-arrival hand-off actually lands on (see
 * `background.ts`'s `handOff`), instead of navigating straight to
 * `nisi://`. It fires the deep link itself, and closes the tab immediately
 * afterward only once the user has explicitly said to — see
 * `AUTO_CLOSE_STORAGE_KEY` below.
 *
 * Why it fires the deep link itself, not `background.ts`: a top-level
 * navigation to an unregistered scheme is attributed, for Chrome's
 * external-protocol "always allow this app" memory, to whatever origin
 * initiated it. A `chrome.tabs.update` call from the service worker and a
 * same-origin `window.location` assignment made *from this page* both
 * attribute to this extension's own origin (`chrome-extension://<id>`) —
 * confirmed against Chrome's `ExternalProtocolHandler` source and by
 * inspecting a real profile's `Preferences` after clicking "always allow"
 * — so either would keep one approval covering every repo. What matters is
 * *not* firing it from a `chrome.tabs.update` call issued while the tab is
 * still showing github.com and then immediately removing the tab: if the
 * confirmation dialog is still pending at that point, closing the tab
 * tears the dialog down with it, and the hand-off never completes. Staying
 * on this page sidesteps that regardless of which way the deep link is
 * fired.
 *
 * Why it doesn't close itself on some detected signal: Chrome gives no
 * way, from page JS or any extension API, to tell "the confirmation dialog
 * is currently showing" apart from "the app already launched silently" —
 *   - `window`/`document` fire no `blur`, `focus`, `visibilitychange`, or
 *     `pagehide`/`unload` event for either case on their own; forcing the
 *     tab into the foreground first, `blur` *does* reliably fire the
 *     moment the dialog appears (confirmed empirically), but a silently
 *     launched app can just as easily steal focus back and produce the
 *     same `blur` — Chromium's own `platform_util_mac.mm` launches external
 *     apps with `NSWorkspace` activation on by default, so the two cases
 *     aren't distinguishable this way either.
 *   - the profile pref that remembers "always allow" isn't exposed to
 *     extensions through `chrome.tabs`, `chrome.windows`, `chrome.privacy`,
 *     or `chrome.contentSettings`.
 *   - `chrome.windows.onFocusChanged` firing with `WINDOW_ID_NONE` (a
 *     non-Chrome app took the foreground) only rules the dialog *out* — it
 *     never fires while the dialog is up, since the dialog is Chrome-owned
 *     — but it doesn't rule success *in*: an unrelated app grabbing focus
 *     would fire it too, and an app that never steals focus wouldn't.
 * Closing on any of those would be a guess — exactly how the tab and the
 * hand-off both got lost before.
 *
 * So instead of detecting success, the first hand-off ever always stays
 * put, offering `#enable-auto-close` for the user to assert — having
 * actually watched nisi open — "close automatically from now on". That
 * turns the one undetectable state into one the user confirms exactly
 * once. `AUTO_CLOSE_STORAGE_KEY` in `chrome.storage.sync` (also toggleable
 * from `../routes/options.html`, so it's reversible without clearing
 * extension data) is the only thing that ever triggers an automatic
 * close: once it's set, every later hand-off fires the deep link and
 * closes this tab right after, no detection involved, because the user
 * already watched it work.
 */

const AUTO_CLOSE_STORAGE_KEY = "autoCloseAfterHandoff";

const statusEl = document.getElementById("status") as HTMLElement;
const retryButton = document.getElementById("retry") as HTMLButtonElement;
const githubLink = document.getElementById("github-link") as HTMLAnchorElement;
const enableAutoCloseButton = document.getElementById(
	"enable-auto-close",
) as HTMLButtonElement;

function buildDeepLink(url: string): string {
	return `nisi://open?url=${encodeURIComponent(url)}`;
}

async function getAutoCloseSetting(): Promise<boolean> {
	const stored = await chrome.storage.sync.get([AUTO_CLOSE_STORAGE_KEY]);
	return stored[AUTO_CLOSE_STORAGE_KEY] === true;
}

async function closeThisTab(): Promise<void> {
	const tab = await chrome.tabs.getCurrent();
	if (tab?.id === undefined) return;
	await chrome.tabs.remove(tab.id);
}

/**
 * Fires the deep link, then — only if the user has already confirmed nisi
 * opens, on some earlier hand-off — closes this tab right away. No
 * detection, no timer: the stored flag is the sole authority.
 */
async function fireDeepLink(url: string): Promise<void> {
	window.location.href = buildDeepLink(url);
	if (await getAutoCloseSetting()) {
		await closeThisTab();
	}
}

function enableAutoClose(): void {
	chrome.storage.sync.set({ [AUTO_CLOSE_STORAGE_KEY]: true });
	enableAutoCloseButton.disabled = true;
	enableAutoCloseButton.textContent = "Auto-close enabled for next time";
}

const githubUrl = new URLSearchParams(location.search).get("url");

if (githubUrl === null) {
	statusEl.textContent = "No pull request URL was provided.";
	retryButton.hidden = true;
	githubLink.hidden = true;
	enableAutoCloseButton.hidden = true;
} else {
	githubLink.href = githubUrl;
	retryButton.addEventListener("click", () => {
		fireDeepLink(githubUrl);
	});
	enableAutoCloseButton.addEventListener("click", enableAutoClose);
	fireDeepLink(githubUrl);
}
