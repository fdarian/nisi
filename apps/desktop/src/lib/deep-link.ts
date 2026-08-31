/**
 * `nisi://open?url=<encoded github url>` — the app owns this grammar; the
 * Chrome extension (Phase 4) only forwards a GitHub PR URL verbatim through
 * it. Delegates the GitHub half to `parsePullRequestUrl`.
 */
import { type PullRequestUrlParts, parsePullRequestUrl } from "#/lib/pr-data";

const DEEP_LINK_SCHEMES = ["nisi"];

export type NisiDeepLink = {
	kind: "open-pull-request";
	pullRequest: PullRequestUrlParts;
};

/**
 * Returns `null` for anything that isn't a recognized nisi deep link —
 * a malformed or hand-typed one is an expected "not ours" outcome, not a
 * parse error (see the plan's "Negative" verification case: a non-GitHub
 * `url=` should drop silently, not crash).
 */
export function parseNisiDeepLink(rawUrl: string): NisiDeepLink | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch {
		return null;
	}

	const scheme = parsed.protocol.replace(/:$/, "");
	if (!DEEP_LINK_SCHEMES.includes(scheme)) return null;
	// `new URL("nisi://open?url=…")` parses "open" as the hostname, not a
	// path segment — non-special schemes like this one still get the
	// `//host` authority treatment.
	if (parsed.hostname !== "open") return null;

	const encodedUrl = parsed.searchParams.get("url");
	if (encodedUrl === null) return null;

	const pullRequest = parsePullRequestUrl(encodedUrl);
	if (pullRequest === null) return null;

	return { kind: "open-pull-request", pullRequest };
}
