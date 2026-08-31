/**
 * The page a direct-arrival hand-off actually lands on (see
 * `background.js`'s `handOff`), instead of navigating straight to
 * `nisi://`. It fires the deep link itself and never closes the tab.
 *
 * Why it fires the deep link itself, not `background.js`: a top-level
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
 * Why it never closes the tab: Chrome gives no way, from page JS or any
 * extension API, to tell "the confirmation dialog is currently showing"
 * apart from "the app already launched silently" —
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
 * The nearest thing to a real signal, `chrome.windows.onFocusChanged`
 * firing with `WINDOW_ID_NONE` (a non-Chrome app took the foreground),
 * only rules the dialog *out* — it never fires while the dialog is up,
 * since the dialog is Chrome-owned — but it doesn't rule success *in*: an
 * unrelated app grabbing focus would fire it too, and an app that never
 * steals focus wouldn't. Closing on it would still be a guess, just a
 * differently-shaped one, so this page doesn't act on it. Auto-closing on
 * a guess is exactly the failure mode above — it's how the tab and the
 * hand-off both got lost before.
 *
 * So both tab-behavior settings converge here: the interstitial is the
 * durable landing place, with a manual retry (the dialog may have been
 * dismissed, or missed) and a link back to the PR on GitHub, since this
 * tab no longer holds the GitHub page as a fallback.
 */

const statusEl = /** @type {HTMLElement} */ (document.getElementById("status"));
const retryButton = /** @type {HTMLButtonElement} */ (
	document.getElementById("retry")
);
const githubLink = /** @type {HTMLAnchorElement} */ (
	document.getElementById("github-link")
);

/**
 * @param {string} url
 * @returns {string}
 */
function buildDeepLink(url) {
	return `nisi://open?url=${encodeURIComponent(url)}`;
}

const githubUrl = new URLSearchParams(location.search).get("url");

if (githubUrl === null) {
	statusEl.textContent = "No pull request URL was provided.";
	retryButton.hidden = true;
	githubLink.hidden = true;
} else {
	githubLink.href = githubUrl;
	retryButton.addEventListener("click", () => {
		window.location.href = buildDeepLink(githubUrl);
	});
	window.location.href = buildDeepLink(githubUrl);
}
