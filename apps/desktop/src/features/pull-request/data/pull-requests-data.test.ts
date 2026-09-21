import { describe, expect, test } from "bun:test";
import type { Session } from "./pr-data";
import {
	findOpenPullRequestSessionId,
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
