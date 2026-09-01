/**
 * MV3 service worker. Watches every top-frame commit on github.com
 * (`host_permissions` already restricts `webNavigation` events to that host,
 * so there's no per-listener URL filter here) and hands a direct-arrival PR
 * page off to the nisi app — see `direct-arrival.ts` for what "direct"
 * means, `bounce-back.ts` for the one case that overrides it, and
 * `interstitial.ts` for the actual `nisi://` deep link and why hand-off
 * doesn't happen straight from here.
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
import { isBounceBackFromInterstitial } from "./bounce-back.js";
import { isDirectArrival } from "./direct-arrival.js";

const INTERSTITIAL_URL_PREFIX = chrome.runtime.getURL("interstitial.html");

function storageKey(tabId: number): string {
	return String(tabId);
}

async function getLastCommittedUrl(tabId: number): Promise<string | undefined> {
	const stored = await chrome.storage.session.get(storageKey(tabId));
	const value = stored[storageKey(tabId)];
	return typeof value === "string" ? value : undefined;
}

async function setLastCommittedUrl(tabId: number, url: string): Promise<void> {
	await chrome.storage.session.set({ [storageKey(tabId)]: url });
}

async function clearLastCommittedUrl(tabId: number): Promise<void> {
	await chrome.storage.session.remove(storageKey(tabId));
}

/**
 * `tab.url` is only populated when the extension has permission to see that
 * tab's origin — we only have `host_permissions` for github.com, so a
 * non-github opener simply comes back `undefined` here. That's the correct
 * outcome for `isDirectArrival`, not a permission gap to work around: an
 * opener we can't see is (almost certainly) not github.com either.
 */
async function getOpenerUrl(tab: chrome.tabs.Tab): Promise<string | undefined> {
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
 * `interstitial.ts` for the deep link and why it never closes the tab
 * itself either.
 */
async function handOff(tabId: number, url: string): Promise<void> {
	const interstitialUrl = `${INTERSTITIAL_URL_PREFIX}?url=${encodeURIComponent(url)}`;
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

	let openerUrl: string | undefined;
	try {
		const tab = await chrome.tabs.get(details.tabId);
		openerUrl = await getOpenerUrl(tab);
	} catch {
		openerUrl = undefined;
	}

	const shouldHandOff =
		!isBounceBackFromInterstitial({
			previousUrl,
			url: details.url,
			interstitialUrlPrefix: INTERSTITIAL_URL_PREFIX,
		}) &&
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
