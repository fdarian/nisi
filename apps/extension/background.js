/**
 * MV3 service worker. Watches every top-frame commit on github.com
 * (`host_permissions` already restricts `webNavigation` events to that host,
 * so there's no per-listener URL filter here) and hands a direct-arrival PR
 * page to the nisi app via a `nisi://`/`nisi-dev://` deep link — see
 * `direct-arrival.js` for what "direct" means.
 *
 * GitHub's own navigation is mostly Turbo (pjax-style `history.pushState`),
 * which never fires `onCommitted` — `onHistoryStateUpdated` is the only
 * signal that keeps this tab's `lastCommittedUrl` accurate between real
 * commits, which is what lets `isDirectArrival` tell "typed a PR URL after
 * browsing GitHub" (not direct) apart from "typed it after browsing
 * anywhere else, or a fresh tab" (direct). The map lives in
 * `chrome.storage.session` rather than a plain module variable because MV3
 * kills this worker between events; a variable would reset to empty on
 * every wake and make every navigation look like a fresh tab.
 */
import { isDirectArrival } from "./direct-arrival.js";

const DEFAULT_SCHEME = "nisi";
const DEFAULT_TAB_BEHAVIOR = "stay";

/** @param {number} tabId */
function storageKey(tabId) {
	return String(tabId);
}

/**
 * @param {number} tabId
 * @returns {Promise<string | undefined>}
 */
async function getLastCommittedUrl(tabId) {
	const stored = await chrome.storage.session.get(storageKey(tabId));
	const value = stored[storageKey(tabId)];
	return typeof value === "string" ? value : undefined;
}

/**
 * @param {number} tabId
 * @param {string} url
 */
async function setLastCommittedUrl(tabId, url) {
	await chrome.storage.session.set({ [storageKey(tabId)]: url });
}

/** @param {number} tabId */
async function clearLastCommittedUrl(tabId) {
	await chrome.storage.session.remove(storageKey(tabId));
}

/**
 * `tab.url` is only populated when the extension has permission to see that
 * tab's origin — we only have `host_permissions` for github.com, so a
 * non-github opener simply comes back `undefined` here. That's the correct
 * outcome for `isDirectArrival`, not a permission gap to work around: an
 * opener we can't see is (almost certainly) not github.com either.
 * @param {chrome.tabs.Tab} tab
 */
async function getOpenerUrl(tab) {
	if (tab.openerTabId === undefined) return undefined;
	try {
		const opener = await chrome.tabs.get(tab.openerTabId);
		return opener.url;
	} catch {
		return undefined;
	}
}

async function getOptions() {
	const stored = await chrome.storage.sync.get(["scheme", "tabBehavior"]);
	return {
		scheme:
			typeof stored.scheme === "string" && stored.scheme.length > 0
				? stored.scheme
				: DEFAULT_SCHEME,
		tabBehavior:
			stored.tabBehavior === "close" ? "close" : DEFAULT_TAB_BEHAVIOR,
	};
}

/**
 * Forwards `details.url` verbatim (`/files`, `#discussion_r…` and all —
 * `parsePullRequestUrl` on the app side tolerates the trailing segment,
 * query, and fragment) as `<scheme>://open?url=<encoded url>`. Per the
 * Phase 0 spike, `chrome.tabs.update` to an unregistered scheme reaches the
 * OS handler without a user gesture and leaves the tab on GitHub with no
 * further navigation event — that's what makes "stay" (the default) a
 * no-op beyond firing the update. "close" additionally removes the tab;
 * the OS handoff has already been dispatched by the time `tabs.remove` runs.
 * @param {number} tabId
 * @param {string} url
 */
async function handOff(tabId, url) {
	const options = await getOptions();
	const deepLink = `${options.scheme}://open?url=${encodeURIComponent(url)}`;
	await chrome.tabs.update(tabId, { url: deepLink });
	if (options.tabBehavior === "close") {
		await chrome.tabs.remove(tabId);
	}
}

chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
	if (details.frameId !== 0) return;
	await setLastCommittedUrl(details.tabId, details.url);
});

chrome.webNavigation.onCommitted.addListener(async (details) => {
	// Read before overwriting below — this is the URL from *before* the
	// navigation `details` describes.
	const previousUrl = await getLastCommittedUrl(details.tabId);

	let openerUrl;
	try {
		const tab = await chrome.tabs.get(details.tabId);
		openerUrl = await getOpenerUrl(tab);
	} catch {
		openerUrl = undefined;
	}

	const shouldHandOff = isDirectArrival({
		frameId: details.frameId,
		url: details.url,
		transitionType: details.transitionType,
		transitionQualifiers: details.transitionQualifiers,
		previousUrl,
		openerUrl,
	});

	if (details.frameId === 0) {
		await setLastCommittedUrl(details.tabId, details.url);
	}

	if (shouldHandOff) {
		await handOff(details.tabId, details.url);
	}
});

chrome.tabs.onRemoved.addListener((tabId) => {
	clearLastCommittedUrl(tabId);
});
