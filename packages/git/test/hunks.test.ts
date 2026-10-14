import { expect, test } from "bun:test";
import { parseChangedRuns } from "../src/hunks.ts";

const PATCH = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -3,8 +3,9 @@
 ctx
 ctx
-old line
+new line
+another new line
 ctx
 ctx
 ctx
-gone
 ctx
@@ -40,3 +41,4 @@ fn
 ctx
+added
 ctx
`;

test("changed runs exclude context and count each side", () => {
	expect(parseChangedRuns(PATCH)).toEqual([
		{ startLine: 5, endLine: 6, additions: 2, deletions: 1 },
		{ startLine: 10, endLine: 10, additions: 0, deletions: 1 },
		{ startLine: 42, endLine: 42, additions: 1, deletions: 0 },
	]);
});

test("a patch with no hunks (binary, pure rename) has no runs", () => {
	expect(
		parseChangedRuns("diff --git a/x.png b/x.png\nBinary files differ\n"),
	).toEqual([]);
});

test("a pure removal is the same run whether or not the patch has context", () => {
	const withContext = `diff --git a/a.ts b/a.ts
@@ -68,5 +68,3 @@
 ctx
 ctx
-gone
-gone too
 ctx
 ctx
`;
	const noContext = `diff --git a/a.ts b/a.ts
@@ -70,2 +69,0 @@
-gone
-gone too
`;
	const expected = [{ startLine: 70, endLine: 70, additions: 0, deletions: 2 }];
	expect(parseChangedRuns(withContext)).toEqual(expected);
	expect(parseChangedRuns(noContext)).toEqual(expected);
});
