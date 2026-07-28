import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { reconcile } from "../src/reconcile.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

/** `diffContents` only needs a real git odb to write blobs into — no commits, no branches. */
const withTempRepo = async <T>(
	fn: (repoRoot: string) => Promise<T>,
): Promise<T> => {
	const root = await mkdtemp(join(tmpdir(), "nisi-reconcile-test-"));
	const proc = Bun.spawn(["git", "init", "-q"], { cwd: root });
	await proc.exited;
	try {
		return await fn(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
};

const numbered = (count: number): Array<string> =>
	Array.from({ length: count }, (_, i) => `line${i + 1}`);

describe("reconcile", () => {
	test("an edit in a different hunk leaves the reviewed hunk collapsed, only the new one surfaces", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(20);
			const reviewed = [...base];
			reviewed[4] = "line5 EDITED AT REVIEW TIME";
			const head = [...reviewed];
			head[14] = "line15 EDITED AFTER REVIEW";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					reviewedContent: `${reviewed.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			// The hunk around line 5 (already reviewed) must stay collapsed...
			const line5Range = result.ranges.find(
				(r) => r.startLine <= 5 && r.endLine >= 5,
			);
			expect(line5Range?.status).toBe("reviewed");
			// ...only the hunk around line 15 (edited after ticking) surfaces.
			const line15Range = result.ranges.find(
				(r) => r.startLine <= 15 && r.endLine >= 15,
			);
			expect(line15Range?.status).toBe("new");
		});
	});

	test("an edit inside an already-reviewed hunk splits it: touched lines are new, the rest stays reviewed", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(20);
			const reviewed = [...base];
			// A reviewed hunk spanning lines 5-9 (all edited relative to base).
			for (let i = 4; i <= 8; i++) reviewed[i] = `line${i + 1} REVIEWED`;
			const head = [...reviewed];
			// Line 7 (inside that same hunk) is edited again after review.
			head[6] = "line7 EDITED AFTER REVIEW";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					reviewedContent: `${reviewed.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			const line7Range = result.ranges.find(
				(r) => r.startLine <= 7 && r.endLine >= 7,
			);
			expect(line7Range?.status).toBe("new");
			// Lines around it, still part of the same base-hunk, stay reviewed.
			const line5Range = result.ranges.find(
				(r) => r.startLine <= 5 && r.endLine >= 5,
			);
			expect(line5Range?.status).toBe("reviewed");
			const line9Range = result.ranges.find(
				(r) => r.startLine <= 9 && r.endLine >= 9,
			);
			expect(line9Range?.status).toBe("reviewed");
		});
	});

	test("reverting to exactly the reviewed content clears changedSinceReview and collapses everything", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = "line1\nline2\nline3\n";
			const reviewed = "line1\nline2 REVIEWED\nline3\n";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: base,
					reviewedContent: reviewed,
					// Head is back to exactly the reviewed snapshot.
					headContent: reviewed,
				}),
			);

			expect(result.changedSinceReview).toBe(false);
			expect(result.ranges.length).toBeGreaterThan(0);
			expect(result.ranges.every((r) => r.status === "reviewed")).toBe(true);
		});
	});

	test("a reviewed file since deleted (empty head) reports changed, with no head-side ranges to collapse", async () => {
		await withTempRepo(async (repoRoot) => {
			const result = await run(
				reconcile(repoRoot, {
					baseContent: "line1\nline2\n",
					reviewedContent: "line1\nline2 REVIEWED\n",
					headContent: "",
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			expect(result.ranges).toHaveLength(0);
		});
	});

	test("a file reviewed with no changes from base (degenerate: nothing to reconcile)", async () => {
		await withTempRepo(async (repoRoot) => {
			const content = "line1\nline2\nline3\n";
			const result = await run(
				reconcile(repoRoot, {
					baseContent: content,
					reviewedContent: content,
					headContent: content,
				}),
			);

			expect(result.changedSinceReview).toBe(false);
			expect(result.ranges).toHaveLength(0);
		});
	});

	test("line ranges stay correct when an earlier edit shifts every line number below it", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(10);
			const reviewed = [...base];
			reviewed[7] = "line8 REVIEWED"; // reviewed hunk at (pre-shift) line 8

			// Insert two new lines near the top of the file, after review —
			// this pushes the reviewed hunk from line 8 down to line 10.
			const head = [...reviewed];
			head.splice(1, 0, "inserted A", "inserted B");

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					reviewedContent: `${reviewed.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			// The insertion itself (now at head lines 2-3) is new.
			const insertionRange = result.ranges.find(
				(r) => r.startLine <= 2 && r.endLine >= 2,
			);
			expect(insertionRange?.status).toBe("new");
			// The originally-reviewed edit, now shifted to head line 10, is
			// still recognized as reviewed at its *new* position, not its old one.
			const shiftedReviewedRange = result.ranges.find(
				(r) => r.startLine <= 10 && r.endLine >= 10,
			);
			expect(shiftedReviewedRange?.status).toBe("reviewed");
		});
	});

	test("ranges cover a hunk exactly once, in order, with no gaps or overlaps", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(15);
			const reviewed = [...base];
			for (let i = 3; i <= 10; i++) reviewed[i] = `line${i + 1} REVIEWED`;
			const head = [...reviewed];
			head[6] = "line7 EDITED";
			head[8] = "line9 EDITED";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					reviewedContent: `${reviewed.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
				}),
			);

			const inHunk = result.ranges
				.filter((r) => r.startLine >= 4 && r.endLine <= 11)
				.sort((a, b) => a.startLine - b.startLine);
			expect(inHunk[0]?.startLine).toBe(4);
			expect(inHunk.at(-1)?.endLine).toBe(11);
			for (let i = 1; i < inHunk.length; i++) {
				expect(inHunk[i]?.startLine).toBe((inHunk[i - 1]?.endLine ?? 0) + 1);
			}
		});
	});
});
