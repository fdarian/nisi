import { describe, expect, test } from "bun:test";
import { type DirectArrivalInput, isDirectArrival } from "./direct-arrival.js";

const PR_URL = "https://github.com/owner/repo/pull/12";
const GITHUB_URL = "https://github.com/owner/repo";
const NON_GITHUB_URL = "https://slack.com/archives/C1/p1";

/** Fills in the fields every case below overrides only some of. */
function baseInput(overrides: Partial<DirectArrivalInput>): DirectArrivalInput {
	return {
		frameId: 0,
		url: PR_URL,
		transitionType: "link",
		transitionQualifiers: [],
		previousUrl: undefined,
		openerUrl: undefined,
		...overrides,
	};
}

describe("isDirectArrival", () => {
	test("rejects a subframe navigation", () => {
		expect(
			isDirectArrival(baseInput({ frameId: 1, transitionType: "typed" })),
		).toBe(false);
	});

	test("rejects a URL that isn't a PR page", () => {
		expect(
			isDirectArrival(baseInput({ url: GITHUB_URL, transitionType: "typed" })),
		).toBe(false);
	});

	test("tolerates a trailing segment and fragment on the PR URL", () => {
		expect(
			isDirectArrival(
				baseInput({
					url: `${PR_URL}/files#discussion_r1`,
					transitionType: "typed",
				}),
			),
		).toBe(true);
	});

	test("rejects a reload regardless of transition qualifiers", () => {
		expect(
			isDirectArrival(
				baseInput({
					transitionType: "reload",
					transitionQualifiers: ["from_address_bar"],
				}),
			),
		).toBe(false);
	});

	test("rejects a forward/back navigation regardless of transition type", () => {
		expect(
			isDirectArrival(
				baseInput({
					transitionType: "typed",
					transitionQualifiers: ["forward_back"],
				}),
			),
		).toBe(false);
	});

	describe("typed-style transitions hand off regardless of previous URL or opener", () => {
		const typedStyleTransitionTypes: DirectArrivalInput["transitionType"][] = [
			"typed",
			"generated",
			"auto_bookmark",
			"keyword",
		];
		for (const transitionType of typedStyleTransitionTypes) {
			test(transitionType, () => {
				expect(
					isDirectArrival(
						baseInput({
							transitionType,
							previousUrl: GITHUB_URL,
							openerUrl: GITHUB_URL,
						}),
					),
				).toBe(true);
			});
		}
	});

	test("the from_address_bar qualifier hands off even on a link transition", () => {
		expect(
			isDirectArrival(
				baseInput({
					transitionType: "link",
					transitionQualifiers: ["from_address_bar"],
					previousUrl: GITHUB_URL,
				}),
			),
		).toBe(true);
	});

	describe("a link transition with no typed-style signal", () => {
		test("hands off with no previous URL and no opener", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: undefined,
						openerUrl: undefined,
					}),
				),
			).toBe(true);
		});

		test("hands off when the previous URL and opener are both off github.com", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: NON_GITHUB_URL,
						openerUrl: NON_GITHUB_URL,
					}),
				),
			).toBe(true);
		});

		test("rejects when the tab's previous URL was on github.com", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: GITHUB_URL,
						openerUrl: undefined,
					}),
				),
			).toBe(false);
		});

		test("rejects when the opener's URL is on github.com", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: undefined,
						openerUrl: GITHUB_URL,
					}),
				),
			).toBe(false);
		});

		test("rejects when both the previous URL and opener are on github.com", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: GITHUB_URL,
						openerUrl: GITHUB_URL,
					}),
				),
			).toBe(false);
		});

		test("hands off when only the opener is off github.com", () => {
			expect(
				isDirectArrival(
					baseInput({
						previousUrl: undefined,
						openerUrl: NON_GITHUB_URL,
					}),
				),
			).toBe(true);
		});
	});
});
