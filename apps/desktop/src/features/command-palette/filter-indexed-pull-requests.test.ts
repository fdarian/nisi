import { expect, test } from "bun:test";
import type { IndexedPullRequest } from "#/features/pull-request/data/pull-requests-data";
import {
	branchMatchRanges,
	filterIndexedPullRequests,
} from "./filter-indexed-pull-requests";

const pr = (
	number: number,
	overrides: Partial<IndexedPullRequest> = {},
): IndexedPullRequest => ({
	owner: "acme",
	repo: "project",
	number,
	title: `PR ${number}`,
	headRefName: `branch-${number}`,
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

const numbers = (results: { number: number }[]) =>
	results.map((result) => result.number);

test("every term must match, across title, branch, repo and author", () => {
	const rows = [
		pr(1, {
			title: "Fix login crash",
			headRefName: "fix/login",
			author: "bob",
		}),
		pr(2, { title: "Fix signup", headRefName: "feat/signup", author: "carol" }),
		pr(3, { title: "Refactor", headRefName: "refactor/login", author: "bob" }),
	];
	expect(numbers(filterIndexedPullRequests(rows, "FIX", []))).toEqual([2, 1]);
	expect(numbers(filterIndexedPullRequests(rows, "fix login", []))).toEqual([
		1,
	]);
	// "bob" only hits the author and "acme/proj" only the slug: no title/branch hit, so updatedAt decides.
	expect(
		numbers(filterIndexedPullRequests(rows, "bob  acme/proj", [])),
	).toEqual([3, 1]);
	expect(filterIndexedPullRequests(rows, "fix nomatch", [])).toEqual([]);
});

test("number terms match the PR number exactly, with or without #", () => {
	const rows = [pr(12), pr(123), pr(5, { title: "ships v12" })];
	expect(numbers(filterIndexedPullRequests(rows, "#12", []))).toEqual([12]);
	expect(numbers(filterIndexedPullRequests(rows, "12", []))).toEqual([
		12, 5, 123,
	]);
	expect(numbers(filterIndexedPullRequests(rows, "123", []))).toEqual([123]);
	expect(numbers(filterIndexedPullRequests(rows, "12 #123", []))).toEqual([
		123,
	]);
});

test("a number match ranks above title/branch hits, which rank above author/repo-only hits", () => {
	const rows = [
		pr(900, { updatedAt: "2026-10-05T00:00:00Z", author: "login-bot" }),
		pr(901, {
			updatedAt: "2026-10-04T00:00:00Z",
			title: "Fix login",
		}),
		pr(902, {
			updatedAt: "2026-10-03T00:00:00Z",
			headRefName: "login-page",
		}),
		pr(42, { updatedAt: "2026-10-01T00:00:00Z" }),
	];
	expect(numbers(filterIndexedPullRequests(rows, "login", []))).toEqual([
		901, 902, 900,
	]);
	expect(numbers(filterIndexedPullRequests(rows, "login 902", []))).toEqual([
		902,
	]);
	const withNumberHit = [
		pr(7, { updatedAt: "2026-10-01T00:00:00Z" }),
		pr(8, { updatedAt: "2026-10-09T00:00:00Z", title: "bump to 7" }),
	];
	expect(numbers(filterIndexedPullRequests(withNumberHit, "7", []))).toEqual([
		7, 8,
	]);
});

test("repos restrict case-insensitively; empty query lists those repos", () => {
	const rows = [
		pr(1, { owner: "Acme", repo: "Project" }),
		pr(2, { owner: "acme", repo: "other" }),
	];
	expect(
		numbers(filterIndexedPullRequests(rows, "", ["ACME/project"])),
	).toEqual([1]);
	expect(
		numbers(
			filterIndexedPullRequests(rows, "pr", ["acme/PROJECT", "acme/other"]),
		),
	).toEqual([2, 1]);
	expect(filterIndexedPullRequests(rows, "pr", ["acme/missing"])).toEqual([]);
});

test("empty query with no repos returns nothing", () => {
	expect(filterIndexedPullRequests([pr(1)], "  ", [])).toEqual([]);
});

test("results are sorted by updatedAt desc across repos and capped at 30", () => {
	const rows = Array.from({ length: 40 }, (_, i) =>
		pr(i + 1, {
			repo: i < 20 ? "a" : "b",
			updatedAt: `2026-10-01T00:00:${String(i).padStart(2, "0")}Z`,
		}),
	);
	const results = filterIndexedPullRequests(rows, "", ["acme/a", "acme/b"]);
	expect(results).toHaveLength(30);
	expect(numbers(results)).toEqual(
		Array.from({ length: 30 }, (_, i) => 40 - i),
	);
	expect(results[0]).toMatchObject({ repo: "b", number: 40 });
});

test("branchMatchRanges returns where a term hits the branch", () => {
	expect(branchMatchRanges("fix/login-crash", "login")).toEqual([
		{ start: 4, end: 9 },
	]);
});

test("branchMatchRanges is empty when the branch doesn't match", () => {
	expect(branchMatchRanges("fix/login-crash", "signup")).toEqual([]);
	expect(branchMatchRanges("fix/login-crash", "")).toEqual([]);
});

test("branchMatchRanges collects every occurrence of every term", () => {
	expect(branchMatchRanges("fix/fix-login", "login fix")).toEqual([
		{ start: 0, end: 3 },
		{ start: 4, end: 7 },
		{ start: 8, end: 13 },
	]);
});

test("branchMatchRanges merges overlapping and adjacent ranges", () => {
	expect(branchMatchRanges("abcdef", "abc cde")).toEqual([
		{ start: 0, end: 5 },
	]);
	expect(branchMatchRanges("abcdef", "abc def")).toEqual([
		{ start: 0, end: 6 },
	]);
	expect(branchMatchRanges("aaaa", "aa")).toEqual([{ start: 0, end: 4 }]);
});

test("branchMatchRanges ignores #123 terms", () => {
	expect(branchMatchRanges("fix/123-login", "#123")).toEqual([]);
	expect(branchMatchRanges("fix/123-login", "#123 login")).toEqual([
		{ start: 8, end: 13 },
	]);
});

test("branchMatchRanges hits bare digits as text", () => {
	expect(branchMatchRanges("fix/123-login", "123")).toEqual([
		{ start: 4, end: 7 },
	]);
});

test("branchMatchRanges is case-insensitive and indexes the original branch", () => {
	expect(branchMatchRanges("Fix/LOGIN", "LoGiN")).toEqual([
		{ start: 4, end: 9 },
	]);
});
