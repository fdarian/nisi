import { expect, test } from "bun:test";
import { filesInArea, isExemptFromAreas, matchesGlob } from "./areas";

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
	expect(stats.files.map((file) => file.path)).toEqual(["src/a.ts"]);
	expect([stats.additions, stats.deletions]).toEqual([3, 1]);
});
