import { expect, test } from "bun:test";
import type { OpenPullRequestIndex } from "../src/github/github.ts";
import { searchOpenPullRequestIndexes } from "../src/github/index-search.ts";

type IndexPr = OpenPullRequestIndex["prs"][number];

const pr = (number: number, overrides: Partial<IndexPr> = {}): IndexPr => ({
	number,
	title: `PR ${number}`,
	baseRef: "main",
	headRef: `branch-${number}`,
	isCrossRepository: false,
	headOwner: null,
	updatedAt: `2026-10-01T00:00:${String(number % 60).padStart(2, "0")}Z`,
	state: "OPEN",
	author: "alice",
	url: `https://github.com/acme/project/pull/${number}`,
	isDraft: false,
	mergeable: "MERGEABLE",
	mergeStateStatus: "CLEAN",
	rollupState: "SUCCESS",
	...overrides,
});

const index = (
	owner: string,
	repo: string,
	prs: IndexPr[],
): OpenPullRequestIndex => ({
	repository: { owner, repo, defaultBranch: "main" },
	prs,
});

const numbers = (results: { number: number }[]) =>
	results.map((result) => result.number);

test("every term must match, across title, branch, repo and author", () => {
	const indexes = [
		index("acme", "project", [
			pr(1, { title: "Fix login crash", headRef: "fix/login", author: "bob" }),
			pr(2, { title: "Fix signup", headRef: "feat/signup", author: "carol" }),
			pr(3, { title: "Refactor", headRef: "refactor/login", author: "bob" }),
		]),
	];
	expect(numbers(searchOpenPullRequestIndexes(indexes, "FIX", []))).toEqual([
		2, 1,
	]);
	expect(
		numbers(searchOpenPullRequestIndexes(indexes, "fix login", [])),
	).toEqual([1]);
	expect(
		numbers(searchOpenPullRequestIndexes(indexes, "bob  acme/proj", [])),
	).toEqual([3, 1]);
	expect(searchOpenPullRequestIndexes(indexes, "fix nomatch", [])).toEqual([]);
});

test("number terms match the PR number exactly, with or without #", () => {
	const indexes = [
		index("acme", "project", [pr(12), pr(123), pr(5, { title: "ships v12" })]),
	];
	expect(numbers(searchOpenPullRequestIndexes(indexes, "#12", []))).toEqual([
		12,
	]);
	expect(numbers(searchOpenPullRequestIndexes(indexes, "12", []))).toEqual([
		12, 5, 123,
	]);
	expect(numbers(searchOpenPullRequestIndexes(indexes, "123", []))).toEqual([
		123,
	]);
	expect(numbers(searchOpenPullRequestIndexes(indexes, "12 #123", []))).toEqual(
		[123],
	);
});

test("repos restrict case-insensitively; empty query lists those repos", () => {
	const indexes = [
		index("Acme", "Project", [pr(1)]),
		index("acme", "other", [pr(2)]),
	];
	expect(
		numbers(searchOpenPullRequestIndexes(indexes, "", ["ACME/project"])),
	).toEqual([1]);
	expect(
		numbers(
			searchOpenPullRequestIndexes(indexes, "pr", [
				"acme/PROJECT",
				"acme/other",
			]),
		),
	).toEqual([2, 1]);
	expect(searchOpenPullRequestIndexes(indexes, "pr", ["acme/missing"])).toEqual(
		[],
	);
});

test("empty query with no repos returns nothing", () => {
	expect(
		searchOpenPullRequestIndexes([index("acme", "project", [pr(1)])], "  ", []),
	).toEqual([]);
});

test("only open PRs are returned", () => {
	const indexes = [
		index("acme", "project", [
			pr(1),
			pr(2, { state: "MERGED" }),
			pr(3, { state: "CLOSED" }),
		]),
	];
	expect(
		numbers(searchOpenPullRequestIndexes(indexes, "", ["acme/project"])),
	).toEqual([1]);
});

test("results are sorted by updatedAt desc across repos and capped at 30", () => {
	const many = Array.from({ length: 40 }, (_, i) =>
		pr(i + 1, { updatedAt: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z` }),
	);
	const results = searchOpenPullRequestIndexes(
		[index("acme", "a", many.slice(0, 20)), index("acme", "b", many.slice(20))],
		"",
		["acme/a", "acme/b"],
	);
	expect(results).toHaveLength(30);
	expect(numbers(results)).toEqual(
		Array.from({ length: 30 }, (_, i) => 40 - i),
	);
	expect(results[0]).toMatchObject({ owner: "acme", repo: "b", number: 40 });
});
