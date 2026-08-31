import { describe, expect, test } from "bun:test";
import { parseNisiDeepLink } from "./deep-link.ts";
import { parsePullRequestUrl } from "./pr-data.ts";

describe("parsePullRequestUrl", () => {
	test("parses a bare PR url", () => {
		expect(
			parsePullRequestUrl("https://github.com/owner/repo/pull/12"),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("tolerates a trailing /files segment", () => {
		expect(
			parsePullRequestUrl("https://github.com/owner/repo/pull/12/files"),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("tolerates a trailing /commits/<sha> segment", () => {
		expect(
			parsePullRequestUrl(
				"https://github.com/owner/repo/pull/12/commits/abc123",
			),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("tolerates a query string", () => {
		expect(
			parsePullRequestUrl("https://github.com/owner/repo/pull/12?diff=split"),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("tolerates a fragment", () => {
		expect(
			parsePullRequestUrl(
				"https://github.com/owner/repo/pull/12#discussion_r1",
			),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("tolerates a trailing segment, query, and fragment together", () => {
		expect(
			parsePullRequestUrl(
				"https://github.com/owner/repo/pull/12/files?diff=split#discussion_r1",
			),
		).toEqual({ owner: "owner", repo: "repo", number: 12 });
	});

	test("rejects a non-github.com host", () => {
		expect(
			parsePullRequestUrl("https://example.com/owner/repo/pull/12"),
		).toBeNull();
	});

	test("rejects a github.com url that isn't a PR page", () => {
		expect(parsePullRequestUrl("https://github.com/owner/repo")).toBeNull();
		expect(
			parsePullRequestUrl("https://github.com/owner/repo/issues/12"),
		).toBeNull();
	});

	test("rejects a malformed url", () => {
		expect(parsePullRequestUrl("not a url")).toBeNull();
	});
});

describe("parseNisiDeepLink", () => {
	test("parses a nisi:// open link wrapping a PR url", () => {
		const encoded = encodeURIComponent("https://github.com/owner/repo/pull/12");
		expect(parseNisiDeepLink(`nisi://open?url=${encoded}`)).toEqual({
			kind: "open-pull-request",
			pullRequest: { owner: "owner", repo: "repo", number: 12 },
		});
	});

	test("rejects the retired nisi-dev:// scheme", () => {
		const encoded = encodeURIComponent("https://github.com/owner/repo/pull/12");
		expect(parseNisiDeepLink(`nisi-dev://open?url=${encoded}`)).toBeNull();
	});

	test("tolerates a trailing segment and fragment on the wrapped url", () => {
		const encoded = encodeURIComponent(
			"https://github.com/owner/repo/pull/12/files#discussion_r1",
		);
		expect(parseNisiDeepLink(`nisi://open?url=${encoded}`)).toEqual({
			kind: "open-pull-request",
			pullRequest: { owner: "owner", repo: "repo", number: 12 },
		});
	});

	test("rejects an unrecognized scheme", () => {
		const encoded = encodeURIComponent("https://github.com/owner/repo/pull/12");
		expect(parseNisiDeepLink(`other://open?url=${encoded}`)).toBeNull();
	});

	test("rejects a nisi link with no open host", () => {
		const encoded = encodeURIComponent("https://github.com/owner/repo/pull/12");
		expect(parseNisiDeepLink(`nisi://close?url=${encoded}`)).toBeNull();
	});

	test("rejects a nisi link missing the url param", () => {
		expect(parseNisiDeepLink("nisi://open")).toBeNull();
	});

	test("rejects a nisi link whose url param isn't a PR url", () => {
		const encoded = encodeURIComponent("https://example.com/nope");
		expect(parseNisiDeepLink(`nisi://open?url=${encoded}`)).toBeNull();
	});

	test("rejects a malformed url", () => {
		expect(parseNisiDeepLink("not a url")).toBeNull();
	});
});
