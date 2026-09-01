/**
 * The hand-off decision, kept free of any `chrome.*` call so it's plain-value
 * unit-testable (see `direct-arrival.test.ts`) — `background.ts` is the only
 * caller, and owns gathering the inputs from `chrome.webNavigation`/`chrome.tabs`.
 *
 * "Direct arrival" means: the user landed on a GitHub PR page from outside
 * GitHub — a Slack link, a typed/pasted URL, a bookmark — not by clicking
 * around GitHub itself. A `typed`/`generated`/`auto_bookmark`/`keyword`
 * transition (or the `from_address_bar` qualifier) is direct on its own,
 * regardless of what the tab or its opener were showing before. Otherwise,
 * it's direct only if neither the tab's own last committed URL nor its
 * opener's URL was on github.com — a `link` transition arriving that way
 * still means "opened from somewhere outside GitHub", just not through the
 * omnibox (e.g. a `target=_blank` link from a non-GitHub page).
 */

const PULL_REQUEST_URL_PATTERN =
	/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/;

const TYPED_TRANSITION_TYPES = new Set([
	"typed",
	"generated",
	"auto_bookmark",
	"keyword",
]);

export interface DirectArrivalInput {
	/** `0` is the top-level frame; anything else is a subframe. */
	frameId: number;
	/** the committed URL (`chrome.webNavigation.onCommitted`'s `details.url`). */
	url: string;
	transitionType: `${chrome.webNavigation.TransitionType}`;
	transitionQualifiers: `${chrome.webNavigation.TransitionQualifier}`[];
	/** the tab's last committed URL before this navigation, if known. */
	previousUrl: string | undefined;
	/** the opener tab's current URL, if known. */
	openerUrl: string | undefined;
}

function isOnGithub(url: string | undefined): boolean {
	if (url === undefined) return false;
	try {
		return new URL(url).hostname === "github.com";
	} catch {
		return false;
	}
}

export function isDirectArrival(input: DirectArrivalInput): boolean {
	if (input.frameId !== 0) return false;
	if (!PULL_REQUEST_URL_PATTERN.test(input.url)) return false;
	if (input.transitionType === "reload") return false;
	if (input.transitionQualifiers.includes("forward_back")) return false;

	if (TYPED_TRANSITION_TYPES.has(input.transitionType)) return true;
	if (input.transitionQualifiers.includes("from_address_bar")) return true;

	return !isOnGithub(input.previousUrl) && !isOnGithub(input.openerUrl);
}
