/**
 * MV3 service worker. Watches every top-frame commit on github.com
 * (`host_permissions` already restricts `webNavigation` events to that host,
 * so there's no per-listener URL filter here) and hands a direct-arrival PR
 * page off to the nisi app — see `direct-arrival.js` for what "direct"
 * means, and `interstitial.js` for the actual `nisi://` deep link and why
 * hand-off doesn't happen straight from here.
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
 * The interstitial's "Open on GitHub" link navigates the tab straight back
 * to the PR URL it just came from — to `isDirectArrival`, that looks
 * exactly like a fresh arrival (the previous URL isn't github.com, since
 * it's this extension's own page), which would hand off again and bounce
 * the user right back to the interstitial instead of letting them read the
 * PR. Recognizing that specific case here, instead of teaching
 * `isDirectArrival` about pages outside its GitHub/opener vocabulary, is
 * what keeps that function pure and github-only.
 * @param {string | undefined} url
 * @returns {boolean}
 */
function isInterstitialUrl(url) {
	return url?.startsWith(chrome.runtime.getURL("interstitial.html")) ?? false;
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

/**
 * Navigates the tab to the extension's own interstitial page instead of
 * straight to `nisi://` — `interstitial.html?url=<encoded github url>`
 * carries the PR URL over so the interstitial can fire the deep link
 * itself. Firing `nisi://` directly from here and then optionally removing
 * the tab (the old design) could tear down Chrome's external-protocol
 * confirmation dialog mid-flight: if the user hadn't yet approved the
 * hand-off, closing the tab kills the pending dialog, and the PR page is
 * gone too. Routing through a page that stays put sidesteps that — see
 * `interstitial.js` for the deep link and why it never closes the tab
 * itself either.
 * @param {number} tabId
 * @param {string} url
 */
async function handOff(tabId, url) {
	const interstitialUrl = `${chrome.runtime.getURL("interstitial.html")}?url=${encodeURIComponent(url)}`;
	await chrome.tabs.update(tabId, { url: interstitialUrl });
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

	const shouldHandOff =
		!isInterstitialUrl(previousUrl) &&
		isDirectArrival({
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
