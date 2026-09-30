import { expect, test } from "bun:test";
import type { PullRequestSearchResult } from "#/features/pull-request/data/pull-requests-data";
import { createMockSidecarClient } from "../../../.storybook/mock-orpc";

const pr: PullRequestSearchResult = {
	owner: "fdarian",
	repo: "furl",
	number: 42,
	title: "Add repository filters",
	author: "fdarian",
	updatedAt: "2026-09-30T12:00:00Z",
	url: "https://github.com/fdarian/furl/pull/42",
	isDraft: false,
	state: "OPEN",
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	rollupState: "SUCCESS",
};

test("palette story fixtures filter PRs by query and repository with OR semantics", async () => {
	const otherPr = { ...pr, repo: "nisi", number: 17 };
	const client = createMockSidecarClient({
		pullRequestSearchResults: [pr, otherPr],
	});
	expect(await client.pullRequests.search({ query: "", repos: [] })).toEqual([
		pr,
		otherPr,
	]);
	expect(
		await client.pullRequests.search({
			query: "FILTERS",
			repos: ["fdarian/furl"],
		}),
	).toEqual([pr]);
	expect(
		await client.pullRequests.search({
			query: "",
			repos: ["fdarian/furl", "fdarian/nisi"],
		}),
	).toEqual([pr, otherPr]);
	expect(
		await client.pullRequests.search({ query: "missing", repos: [] }),
	).toEqual([]);
});

test("palette story returns the configured saved repository identities", async () => {
	const repositories = [{ owner: "acme", repo: "widgets" }];
	const client = createMockSidecarClient({
		pullRequestRepositories: repositories,
	});
	expect(await client.pullRequests.repositories()).toEqual(repositories);
});
