import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	hasUnreviewedRanges,
	type ReviewClaim,
	reconcile,
} from "../src/reconcile.ts";

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

/** A whole-file claim — the degenerate case of a claim ranging over the entire file. */
const fileClaim = (snapshotContent: string, viewedAt = 0): ReviewClaim => ({
	source: { kind: "file" },
	snapshotContent,
	ranges: null,
	viewedAt,
});

const rangeClaim = (
	snapshotContent: string,
	ranges: ReadonlyArray<{ startLine: number; endLine: number }>,
	blockId: string,
	viewedAt = 0,
): ReviewClaim => ({
	source: { kind: "range", blockId, blockLabel: `Block ${blockId}` },
	snapshotContent,
	ranges,
	viewedAt,
});

describe("reconcile — whole-file claim (Phase 2 behavior, generalized)", () => {
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
					headContent: `${head.join("\n")}\n`,
					claims: [fileClaim(`${reviewed.join("\n")}\n`)],
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			const line5Range = result.ranges.find(
				(r) => r.startLine <= 5 && r.endLine >= 5,
			);
			expect(line5Range?.status).toBe("reviewed");
			expect(line5Range?.reviewedVia).toEqual({ kind: "file" });
			const line15Range = result.ranges.find(
				(r) => r.startLine <= 15 && r.endLine >= 15,
			);
			expect(line15Range?.status).toBe("new");
			expect(line15Range?.reviewedVia).toBeNull();
		});
	});

	test("an edit inside an already-reviewed hunk splits it: touched lines are new, the rest stays reviewed", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(20);
			const reviewed = [...base];
			for (let i = 4; i <= 8; i++) reviewed[i] = `line${i + 1} REVIEWED`;
			const head = [...reviewed];
			head[6] = "line7 EDITED AFTER REVIEW";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
					claims: [fileClaim(`${reviewed.join("\n")}\n`)],
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			const line7Range = result.ranges.find(
				(r) => r.startLine <= 7 && r.endLine >= 7,
			);
			expect(line7Range?.status).toBe("new");
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
					headContent: reviewed,
					claims: [fileClaim(reviewed)],
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
					headContent: "",
					claims: [fileClaim("line1\nline2 REVIEWED\n")],
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
					headContent: content,
					claims: [fileClaim(content)],
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

			const head = [...reviewed];
			head.splice(1, 0, "inserted A", "inserted B");

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
					claims: [fileClaim(`${reviewed.join("\n")}\n`)],
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			const insertionRange = result.ranges.find(
				(r) => r.startLine <= 2 && r.endLine >= 2,
			);
			expect(insertionRange?.status).toBe("new");
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
					headContent: `${head.join("\n")}\n`,
					claims: [fileClaim(`${reviewed.join("\n")}\n`)],
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

describe("reconcile — range claims", () => {
	test("a range reviewed then edited inside it goes new, attributed to no one", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(20);
			const reviewed = [...base];
			for (let i = 4; i <= 8; i++) reviewed[i] = `line${i + 1} CHANGED`; // lines 5-9 differ from base
			const head = [...reviewed];
			head[6] = "line7 EDITED AFTER CLAIM"; // edit inside the claimed range

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
					claims: [
						rangeClaim(
							`${reviewed.join("\n")}\n`,
							[{ startLine: 5, endLine: 9 }],
							"b1",
						),
					],
				}),
			);

			const line7 = result.ranges.find(
				(r) => r.startLine <= 7 && r.endLine >= 7,
			);
			expect(line7?.status).toBe("new");
			expect(line7?.reviewedVia).toBeNull();
			const line5 = result.ranges.find(
				(r) => r.startLine <= 5 && r.endLine >= 5,
			);
			expect(line5?.status).toBe("reviewed");
			expect(line5?.reviewedVia).toEqual({
				kind: "range",
				blockId: "b1",
				blockLabel: "Block b1",
			});
		});
	});

	test("a range reviewed then edited elsewhere in the same file stays reviewed", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(20);
			const reviewed = [...base];
			reviewed[6] = "line7 CHANGED"; // line 7 differs from base
			reviewed[14] = "line15 CHANGED"; // line 15 differs from base too
			const head = [...reviewed];
			head[14] = "line15 EDITED AFTER CLAIM"; // edit outside the claimed range

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
					claims: [
						rangeClaim(
							`${reviewed.join("\n")}\n`,
							[{ startLine: 7, endLine: 7 }],
							"b1",
						),
					],
				}),
			);

			const line7 = result.ranges.find(
				(r) => r.startLine <= 7 && r.endLine >= 7,
			);
			expect(line7?.status).toBe("reviewed");
			expect(line7?.reviewedVia).toEqual({
				kind: "range",
				blockId: "b1",
				blockLabel: "Block b1",
			});
			// Line 15 changed since base, but nothing claimed it — it's new.
			const line15 = result.ranges.find(
				(r) => r.startLine <= 15 && r.endLine >= 15,
			);
			expect(line15?.status).toBe("new");
		});
	});

	test("two overlapping ranges from different blocks: the more recently ticked one wins attribution", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(10);
			const reviewed = [...base];
			for (let i = 2; i <= 6; i++) reviewed[i] = `line${i + 1} CHANGED`; // lines 3-7 differ from base

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${reviewed.join("\n")}\n`,
					claims: [
						rangeClaim(
							`${reviewed.join("\n")}\n`,
							[{ startLine: 3, endLine: 5 }],
							"early",
							100,
						),
						rangeClaim(
							`${reviewed.join("\n")}\n`,
							[{ startLine: 4, endLine: 7 }],
							"late",
							200,
						),
					],
				}),
			);

			// Line 4-5 is covered by both — the later claim ("late") wins attribution.
			const line4 = result.ranges.find(
				(r) => r.startLine <= 4 && r.endLine >= 4,
			);
			expect(line4?.reviewedVia).toEqual({
				kind: "range",
				blockId: "late",
				blockLabel: "Block late",
			});
			// Line 3 is only covered by "early".
			const line3 = result.ranges.find(
				(r) => r.startLine <= 3 && r.endLine >= 3,
			);
			expect(line3?.reviewedVia).toEqual({
				kind: "range",
				blockId: "early",
				blockLabel: "Block early",
			});
			// Line 7 is only covered by "late".
			const line7 = result.ranges.find(
				(r) => r.startLine <= 7 && r.endLine >= 7,
			);
			expect(line7?.reviewedVia).toEqual({
				kind: "range",
				blockId: "late",
				blockLabel: "Block late",
			});
			expect(result.changedSinceReview).toBe(false);
		});
	});

	test("a claimed range reviewed then the file reverted to base clears it (nothing left to reconcile against)", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = "line1\nline2\nline3\nline4\nline5\n";
			const reviewed = "line1\nline2 CLAIMED\nline3\nline4\nline5\n";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: base,
					// Head reverted all the way back to base — nothing differs from base anymore.
					headContent: base,
					claims: [rangeClaim(reviewed, [{ startLine: 2, endLine: 2 }], "b1")],
				}),
			);

			expect(result.ranges).toHaveLength(0);
			expect(result.changedSinceReview).toBe(false);
		});
	});

	test("a whole-file claim and a range claim both surviving on the same line: most recent wins", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = "line1\nline2\nline3\n";
			const reviewed = "line1\nline2 CHANGED\nline3\n";

			const result = await run(
				reconcile(repoRoot, {
					baseContent: base,
					headContent: reviewed,
					claims: [
						fileClaim(reviewed, 100),
						rangeClaim(reviewed, [{ startLine: 2, endLine: 2 }], "b1", 200),
					],
				}),
			);

			const line2 = result.ranges.find(
				(r) => r.startLine <= 2 && r.endLine >= 2,
			);
			expect(line2?.status).toBe("reviewed");
			expect(line2?.reviewedVia).toEqual({
				kind: "range",
				blockId: "b1",
				blockLabel: "Block b1",
			});
		});
	});

	test("line ranges stay correct for a range claim when an edit above it shifts numbering", async () => {
		await withTempRepo(async (repoRoot) => {
			const base = numbered(10);
			const reviewed = [...base];
			reviewed[7] = "line8 CLAIMED"; // claim anchored at (pre-shift) line 8

			const head = [...reviewed];
			head.splice(1, 0, "inserted A", "inserted B"); // shifts everything below by +2

			const result = await run(
				reconcile(repoRoot, {
					baseContent: `${base.join("\n")}\n`,
					headContent: `${head.join("\n")}\n`,
					claims: [
						rangeClaim(
							`${reviewed.join("\n")}\n`,
							[{ startLine: 8, endLine: 8 }],
							"b1",
						),
					],
				}),
			);

			// The claim's line 8 is now at head line 10.
			const shifted = result.ranges.find(
				(r) => r.startLine <= 10 && r.endLine >= 10,
			);
			expect(shifted?.status).toBe("reviewed");
			expect(shifted?.reviewedVia).toEqual({
				kind: "range",
				blockId: "b1",
				blockLabel: "Block b1",
			});
			// The inserted lines themselves (now at head lines 2-3) are new — nothing claimed them.
			const insertion = result.ranges.find(
				(r) => r.startLine <= 2 && r.endLine >= 2,
			);
			expect(insertion?.status).toBe("new");
		});
	});
});

describe("hasUnreviewedRanges", () => {
	test("false when every range reconciled as reviewed", async () => {
		await withTempRepo(async (repoRoot) => {
			const content = "line1\nline2 REVIEWED\nline3\n";
			const result = await run(
				reconcile(repoRoot, {
					baseContent: "line1\nline2\nline3\n",
					headContent: content,
					claims: [fileClaim(content)],
				}),
			);

			expect(hasUnreviewedRanges(result)).toBe(false);
		});
	});

	test("true when a range came back new", async () => {
		await withTempRepo(async (repoRoot) => {
			const result = await run(
				reconcile(repoRoot, {
					baseContent: "line1\nline2\nline3\n",
					headContent: "line1\nline2 EDITED\nline3\n",
					claims: [],
				}),
			);

			expect(hasUnreviewedRanges(result)).toBe(true);
		});
	});

	test("false when zero ranges exist at all (nothing changed since base)", async () => {
		await withTempRepo(async (repoRoot) => {
			const content = "line1\nline2\nline3\n";
			const result = await run(
				reconcile(repoRoot, {
					baseContent: content,
					headContent: content,
					claims: [fileClaim(content)],
				}),
			);

			expect(hasUnreviewedRanges(result)).toBe(false);
		});
	});

	test("false even when changedSinceReview is true from a deleted-file file-claim divergence with no ranges", async () => {
		await withTempRepo(async (repoRoot) => {
			const result = await run(
				reconcile(repoRoot, {
					baseContent: "line1\nline2\n",
					headContent: "",
					claims: [fileClaim("line1\nline2 REVIEWED\n")],
				}),
			);

			expect(result.changedSinceReview).toBe(true);
			expect(hasUnreviewedRanges(result)).toBe(false);
		});
	});
});
