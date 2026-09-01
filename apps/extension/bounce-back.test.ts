import { describe, expect, test } from "bun:test";
import { isBounceBackFromInterstitial } from "./bounce-back.js";

const INTERSTITIAL_URL_PREFIX =
	"chrome-extension://abcdefghijklmnopqrstuvwxyzabcdef/interstitial.html";
const PR_URL = "https://github.com/owner/repo/pull/12";
const GITHUB_URL = "https://github.com/owner/repo";

/** The interstitial's own URL, carrying `prUrl` in its `url` query param. */
function interstitialUrl(prUrl: string) {
	return `${INTERSTITIAL_URL_PREFIX}?url=${encodeURIComponent(prUrl)}`;
}

/** Fills in the fields every case below overrides only some of. */
function baseInput(
	overrides: Partial<Parameters<typeof isBounceBackFromInterstitial>[0]>,
) {
	return {
		previousUrl: interstitialUrl(PR_URL),
		url: PR_URL,
		interstitialUrlPrefix: INTERSTITIAL_URL_PREFIX,
		...overrides,
	};
}

describe("isBounceBackFromInterstitial", () => {
	test("suppresses the 'Open on GitHub' escape hatch bouncing back to the exact PR URL", () => {
		expect(isBounceBackFromInterstitial(baseInput({}))).toBe(true);
	});

	test("does not suppress a genuinely new PR arriving while the interstitial is still open", () => {
		expect(
			isBounceBackFromInterstitial(
				baseInput({ url: "https://github.com/owner/repo/pull/99" }),
			),
		).toBe(false);
	});

	test("does not suppress the same PR number in a different repo", () => {
		expect(
			isBounceBackFromInterstitial(
				baseInput({ url: "https://github.com/other-owner/other-repo/pull/12" }),
			),
		).toBe(false);
	});

	test("does not suppress a trailing-segment variant of the same PR (/files)", () => {
		expect(
			isBounceBackFromInterstitial(baseInput({ url: `${PR_URL}/files` })),
		).toBe(false);
	});

	test("does not suppress a fragment variant of the same PR (#discussion_r1)", () => {
		expect(
			isBounceBackFromInterstitial(
				baseInput({ url: `${PR_URL}#discussion_r1` }),
			),
		).toBe(false);
	});

	test("rejects when there's no previous URL", () => {
		expect(
			isBounceBackFromInterstitial(baseInput({ previousUrl: undefined })),
		).toBe(false);
	});

	test("rejects when the previous URL isn't the interstitial", () => {
		expect(
			isBounceBackFromInterstitial(baseInput({ previousUrl: GITHUB_URL })),
		).toBe(false);
	});

	test("rejects when the interstitial carried no url param", () => {
		expect(
			isBounceBackFromInterstitial(
				baseInput({ previousUrl: INTERSTITIAL_URL_PREFIX }),
			),
		).toBe(false);
	});
});
