/**
 * The interstitial's own "Open on GitHub" link navigates the tab straight
 * back to the exact PR URL it was carrying — to `isDirectArrival`, that
 * looks exactly like a fresh arrival (the previous URL isn't github.com,
 * since it's this extension's own page), which would hand off again and
 * bounce the user right back to the interstitial instead of letting them
 * read the PR. Kept free of any `chrome.*` call, like `direct-arrival.ts`,
 * so it's `bun test`-able without a browser (`bounce-back.test.ts`) —
 * `../entries/background.ts`'s `onCommitted` listener is the only caller,
 * and owns computing `interstitialUrlPrefix` via
 * `chrome.runtime.getURL("interstitial.html")`.
 *
 * "Bounce-back" means exactly one thing: `previousUrl` is the interstitial
 * page, and the PR URL it was carrying (its `url` query param) is
 * byte-identical to `url`. That's deliberately narrow, not a fuzzy "same
 * PR" check — the interstitial's escape hatch always round-trips that
 * exact string, so an exact match is a reliable fingerprint for it
 * specifically. Anything else that commits right after the interstitial —
 * a different PR, the same PR number in a different repo, even the same
 * PR with a `/files` suffix or a fragment added — is a real navigation the
 * user made on purpose (typed a new URL, clicked a bookmark, browsed
 * elsewhere) and must still be treated as a fresh arrival, not swallowed.
 * This is a separate concern from `isDirectArrival` (which never looks at
 * this extension's own pages at all) rather than something to fold into
 * it — there's no shared logic between "did this look like it came from
 * outside GitHub" and "is this literally our own escape hatch bouncing
 * back", just the same `previousUrl` input.
 */

export interface BounceBackInput {
	/** the tab's last committed URL before this navigation, if known. */
	previousUrl: string | undefined;
	/** the committed URL (`chrome.webNavigation.onCommitted`'s `details.url`). */
	url: string;
	/** `chrome.runtime.getURL("interstitial.html")`. */
	interstitialUrlPrefix: string;
}

export function isBounceBackFromInterstitial(input: BounceBackInput): boolean {
	if (input.previousUrl === undefined) return false;
	if (!input.previousUrl.startsWith(input.interstitialUrlPrefix)) return false;
	try {
		return new URL(input.previousUrl).searchParams.get("url") === input.url;
	} catch {
		return false;
	}
}
