import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { reconcile } from "@repo/review";
import { Effect } from "effect";
import { optimisticRangeBaseline } from "./optimistic-range-baseline";

test("selected additions become context without covering other additions", () => {
	expect(
		optimisticRangeBaseline("one\n", "one\nfirst\nsecond\n", {
			startLine: 2,
			endLine: 2,
		}),
	).toBe("one\nfirst\n");
	expect(
		optimisticRangeBaseline("", "first\nsecond\n", {
			startLine: 1,
			endLine: 2,
		}),
	).toBe("first\nsecond\n");
});

test("deletions require covered flanks, including at file edges", () => {
	expect(
		optimisticRangeBaseline("before\nremoved\nafter\n", "before\nafter\n", {
			startLine: 1,
			endLine: 2,
		}),
	).toBe("before\nafter\n");
	expect(
		optimisticRangeBaseline("removed\nafter\n", "after\n", {
			startLine: 1,
			endLine: 1,
		}),
	).toBe("removed\nafter\n");
	expect(
		optimisticRangeBaseline(
			"before\nremoved\nafter\nother\n",
			"before\nafter\nother\n",
			{ startLine: 3, endLine: 3 },
		),
	).toBe("before\nremoved\nafter\nother\n");
});

test("an addition beside a deletion must be claimed before it covers that flank", () => {
	expect(
		optimisticRangeBaseline("before\nold\nafter\n", "before\nnew\nafter\n", {
			startLine: 1,
			endLine: 1,
		}),
	).toBe("before\nold\nafter\n");
	expect(
		optimisticRangeBaseline("before\nold\nafter\n", "before\nnew\nafter\n", {
			startLine: 2,
			endLine: 2,
		}),
	).toBe("before\nnew\nafter\n");
});

test("optimistic baseline agrees with reconciliation for selected additions and replacements", async () => {
	const repo = await mkdtemp(join(tmpdir(), "nisi-range-baseline-"));
	try {
		const init = Bun.spawn(["git", "init", "-q", repo]);
		if ((await init.exited) !== 0)
			throw new Error("Could not initialize test repo");
		const cases = [
			{
				base: "one\n",
				head: "one\nnew\n",
				range: { startLine: 2, endLine: 2 },
			},
			{ base: "", head: "one\ntwo\n", range: { startLine: 1, endLine: 2 } },
			{
				base: "before\nold\nafter\n",
				head: "before\nnew\nafter\n",
				range: { startLine: 1, endLine: 3 },
			},
		];
		for (const fixture of cases) {
			const server = await Effect.runPromise(
				reconcile(repo, {
					baseContent: fixture.base,
					headContent: fixture.head,
					claims: [
						{
							source: { kind: "range", blockId: "test", blockLabel: "test" },
							snapshotContent: fixture.head,
							ranges: [fixture.range],
							viewedAt: 1,
						},
					],
				}).pipe(Effect.provide(BunServices.layer)),
			);
			expect(
				optimisticRangeBaseline(fixture.base, fixture.head, fixture.range),
			).toBe(server.reviewedBaseline);
		}
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("multiple pending marks compose against the latest displayed baseline", () => {
	const head = "one\ntwo\nthree\n";
	const first = optimisticRangeBaseline("", head, { startLine: 1, endLine: 1 });
	expect(
		optimisticRangeBaseline(first, head, { startLine: 2, endLine: 2 }),
	).toBe("one\ntwo\n");
});
