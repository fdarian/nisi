import { describe, expect, test } from "bun:test";
import type { Session } from "./pr-data";
import {
	findOpenPullRequestSessionId,
	type IndexedPullRequest,
	type IndexedPullRequestsResponse,
	mergeIncompleteRepos,
	type OpenPullRequestParams,
} from "./pull-requests-data";

const PR: OpenPullRequestParams = {
	owner: "acme",
	repo: "widgets",
	number: 42,
};

const SESSIONS: readonly Session[] = [
	{
		id: "pr-session",
		repoRoot: "/tmp/widgets",
		target: {
			kind: "pr",
			number: 42,
			title: "Add widgets",
			baseRef: "main",
			headRef: "feature/widgets",
			owner: "acme",
			repo: "widgets",
		},
	},
	{
		id: "branch-session",
		repoRoot: "/tmp/other",
		target: { kind: "branch", baseRef: "main", headRef: "feature/other" },
	},
];

describe("findOpenPullRequestSessionId", () => {
	test("returns the existing PR tab, case-insensitively", () => {
		expect(
			findOpenPullRequestSessionId(SESSIONS, {
				...PR,
				owner: "ACME",
				repo: "Widgets",
			}),
		).toBe("pr-session");
	});

	test("returns undefined for an unopened or non-PR session", () => {
		expect(
			findOpenPullRequestSessionId(SESSIONS, {
				...PR,
				number: 99,
			}),
		).toBeUndefined();
	});
});

function indexed(
	owner: string,
	repo: string,
	number: number,
): IndexedPullRequest {
	return {
		owner,
		repo,
		number,
		title: `PR ${number}`,
		author: "octocat",
		updatedAt: "2026-10-01T00:00:00Z",
		url: `https://github.com/${owner}/${repo}/pull/${number}`,
		isDraft: false,
		state: "OPEN",
		headRefName: `branch-${number}`,
	};
}

describe("mergeIncompleteRepos", () => {
	const previous: IndexedPullRequestsResponse = {
		rows: [indexed("Acme", "widgets", 1), indexed("acme", "gadgets", 2)],
		incompleteRepos: [],
	};

	test("returns the response untouched when nothing is incomplete", () => {
		const response = {
			rows: [indexed("acme", "gadgets", 3)],
			incompleteRepos: [],
		};
		expect(mergeIncompleteRepos(response, previous)).toBe(response);
	});

	test("returns the response untouched without previous data", () => {
		const response = { rows: [], incompleteRepos: ["acme/widgets"] };
		expect(mergeIncompleteRepos(response, undefined)).toBe(response);
	});

	test("carries over previous rows of incomplete repos only, matching case-insensitively", () => {
		const fresh = indexed("acme", "gadgets", 3);
		const merged = mergeIncompleteRepos(
			{ rows: [fresh], incompleteRepos: ["acme/widgets"] },
			previous,
		);
		expect(merged.rows).toEqual([fresh, indexed("Acme", "widgets", 1)]);
		expect(merged.incompleteRepos).toEqual(["acme/widgets"]);
	});

	test("is stable when the merged result becomes the next previous", () => {
		const response = { rows: [], incompleteRepos: ["acme/widgets"] };
		const once = mergeIncompleteRepos(response, previous);
		expect(mergeIncompleteRepos(response, once).rows).toEqual(once.rows);
	});
});
