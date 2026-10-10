import { expect, test } from "bun:test";
import {
	filesInArea,
	type GuideFile,
	hunkClaimRange,
	hunkReviewStatus,
	isExemptFromAreas,
	matchesGlob,
	shortestUniqueSuffixes,
	uncoveredHunks,
} from "./areas";

test("globs: * stays in a segment, ** crosses them (and matches none), braces alternate", () => {
	expect(
		matchesGlob("apps/desktop/sidecar/http.ts", "apps/desktop/sidecar/**"),
	).toBe(true);
	expect(
		matchesGlob("apps/desktop/sidecar/a/b.ts", "apps/desktop/sidecar/*.ts"),
	).toBe(false);
	expect(
		matchesGlob("apps/desktop/sidecar/b.ts", "apps/desktop/sidecar/*.ts"),
	).toBe(true);
	expect(matchesGlob("src/x.ts", "src/**/x.ts")).toBe(true);
	expect(matchesGlob("src/a/b/x.ts", "src/**/x.ts")).toBe(true);
	expect(matchesGlob("src/x.tsx", "src/*.{ts,tsx}")).toBe(true);
	expect(matchesGlob("src/xtsx", "src/x.tsx")).toBe(false);
});

test("tests, stories, fixtures, docs and lockfiles are exempt; source is not", () => {
	for (const path of [
		"a/b.test.ts",
		"a/b.spec.tsx",
		"a/b.stories.tsx",
		"a/__fixtures__/x.json",
		"docs/README.md",
		"pnpm-lock.yaml",
		"bun.lock",
	]) {
		expect(isExemptFromAreas(path)).toBe(true);
	}
	expect(isExemptFromAreas("apps/desktop/src/test-utils.ts")).toBe(false);
	expect(isExemptFromAreas("packages/git/src/index.ts")).toBe(false);
});

test("an area's stats sum the matching, non-exempt files", () => {
	const stats = filesInArea(
		[
			{ path: "src/a.ts", additions: 3, deletions: 1 },
			{ path: "src/a.test.ts", additions: 50, deletions: 0 },
			{ path: "lib/b.ts", additions: 9, deletions: 9 },
		],
		["src/**"],
	);
	expect(stats.claimed.map((claim) => claim.file.path)).toEqual(["src/a.ts"]);
	expect([stats.additions, stats.deletions]).toEqual([3, 1]);
});

test("same-named files get the shortest suffix that tells them apart; the rest keep their basename", () => {
	expect(
		shortestUniqueSuffixes([
			"apps/desktop/sidecar/repositories.ts",
			"packages/sidecar-api/src/repositories.ts",
			"apps/desktop/sidecar/http.ts",
			"packages/git/src/github/gh/github.ts",
			"packages/git/src/github/github.ts",
		]),
	).toEqual([
		"sidecar/repositories.ts",
		"src/repositories.ts",
		"http.ts",
		"gh/github.ts",
		"github/github.ts",
	]);
});

const MIDDLEWARE: GuideFile = {
	path: "src/middleware.ts",
	additions: 30,
	deletions: 8,
	hunks: [
		{ startLine: 12, endLine: 38, additions: 20, deletions: 5 },
		{ startLine: 80, endLine: 90, additions: 10, deletions: 3 },
	],
};

test("a `path:lines` entry claims only the hunks overlapping it, and the stats follow", () => {
	const early = filesInArea([MIDDLEWARE], ["src/middleware.ts:10-40"]);
	expect(early.claimed).toHaveLength(1);
	expect(early.claimed[0]?.hunks).toEqual([MIDDLEWARE.hunks?.[0]]);
	expect([early.additions, early.deletions]).toEqual([20, 5]);

	const late = filesInArea([MIDDLEWARE], ["src/middleware.ts:85"]);
	expect(late.claimed[0]?.hunks).toEqual([MIDDLEWARE.hunks?.[1]]);
	expect([late.additions, late.deletions]).toEqual([10, 3]);

	// Both hunks claimed, in any combination, is the whole file again.
	const both = filesInArea(
		[MIDDLEWARE],
		["src/middleware.ts:1-20", "src/middleware.ts:81-82"],
	);
	expect(both.claimed[0]?.hunks).toBeNull();
	expect([both.additions, both.deletions]).toEqual([30, 8]);

	// A glob or a plain path claims every hunk, and a range outside any hunk claims nothing.
	expect(filesInArea([MIDDLEWARE], ["src/**"]).claimed[0]?.hunks).toBeNull();
	expect(
		filesInArea([MIDDLEWARE], ["src/middleware.ts"]).claimed[0]?.hunks,
	).toBeNull();
	expect(
		filesInArea([MIDDLEWARE], ["src/middleware.ts:50-60"]).claimed,
	).toEqual([]);
});

test("a file counts once however many of its hunks are claimed", () => {
	const stats = filesInArea(
		[MIDDLEWARE, { path: "src/other.ts", additions: 1, deletions: 0 }],
		["src/middleware.ts:12", "src/middleware.ts:85", "src/other.ts"],
	);
	expect(stats.claimed.map((claim) => claim.file.path)).toEqual([
		"src/middleware.ts",
		"src/other.ts",
	]);
});

test("generated files and images count toward no area and need no cover", () => {
	const generated: GuideFile = {
		path: "src/gen.ts",
		additions: 100,
		deletions: 0,
		generated: true,
	};
	const png: GuideFile = { path: "docs/shot.png", additions: 0, deletions: 0 };
	expect(filesInArea([generated, png], ["**"]).claimed).toEqual([]);
	expect(uncoveredHunks([generated, png], [])).toEqual([]);
});

test("coverage is per hunk: a hunk no area claims is reported as path:range, a doubly claimed one is fine", () => {
	expect(uncoveredHunks([MIDDLEWARE], [["src/middleware.ts:12-38"]])).toEqual([
		"src/middleware.ts:80-90",
	]);
	expect(uncoveredHunks([MIDDLEWARE], [])).toEqual(["src/middleware.ts"]);
	expect(
		uncoveredHunks(
			[MIDDLEWARE],
			[["src/middleware.ts:12-38"], ["src/middleware.ts:12-90"]],
		),
	).toEqual([]);
	expect(uncoveredHunks([MIDDLEWARE], [["src/**"]])).toEqual([]);
});

const patchOf = (header: string, ...lines: string[]) =>
	["diff --git a/f b/f", header, ...lines].join("\n");

test("a hunk with removed lines is claimed from the unchanged line above it", () => {
	expect(hunkClaimRange({ startLine: 61, endLine: 62 }, 2)).toEqual({
		startLine: 60,
		endLine: 62,
	});
	expect(hunkClaimRange({ startLine: 61, endLine: 62 }, 0)).toEqual({
		startLine: 61,
		endLine: 62,
	});
	expect(hunkClaimRange({ startLine: 1, endLine: 1 }, 1).startLine).toBe(1);
});

test("a hunk reads Reviewed when the diff the pane shows has dropped it, removed lines included", () => {
	const replaced = { startLine: 61, endLine: 62, additions: 2, deletions: 2 };
	const unreviewed = patchOf("@@ -61,2 +61,2 @@", "-a", "-b", "+c", "+d");
	expect(hunkReviewStatus(replaced, unreviewed)).toBe("unreviewed");
	expect(hunkReviewStatus(replaced, "")).toBe("reviewed");
	// the added lines were claimed but the removed ones still show
	expect(
		hunkReviewStatus(replaced, patchOf("@@ -61,2 +60,0 @@", "-a", "-b")),
	).toBe("partial");
	// another hunk's change doesn't count against this one
	expect(
		hunkReviewStatus(replaced, patchOf("@@ -90 +90 @@", "-x", "+y")),
	).toBe("reviewed");
});

test("a pure removal is judged by the removed lines still showing at its position", () => {
	const removal = { startLine: 70, endLine: 70, additions: 0, deletions: 2 };
	expect(
		hunkReviewStatus(removal, patchOf("@@ -70,2 +69,0 @@", "-a", "-b")),
	).toBe("unreviewed");
	expect(hunkReviewStatus(removal, "")).toBe("reviewed");
});
