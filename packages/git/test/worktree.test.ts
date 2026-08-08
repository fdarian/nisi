import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import {
	openPullRequestWorktree,
	revalidateWorktreePath,
} from "../src/worktree.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

/** Runs real `git` for test setup — the code under test uses its own Effect-based runner. */
const sh = async (
	cwd: string,
	args: ReadonlyArray<string>,
): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
	return stdout;
};

type OriginBackedRepo = {
	readonly repo: TestRepo;
	readonly bareDir: string;
	readonly baseSha: string;
};

/**
 * A bare "origin" plus a working repo with `origin` configured and one commit pushed — the minimum
 * shape `openPullRequestWorktree` needs to fetch a PR ref from. `gh`/GitHub aren't involved at all;
 * `publishPullRequestRef` below stands in for what GitHub publishes automatically for a real PR.
 */
const makeOriginBackedRepo = async (): Promise<OriginBackedRepo> => {
	const bareDir = await mkdtemp(join(tmpdir(), "nisi-worktree-origin-"));
	await sh(bareDir, ["init", "-q", "--bare", "-b", "main"]);

	const repo = await makeTestRepo();
	await repo.git(["remote", "add", "origin", bareDir]);
	await repo.write("a.ts", "hello\n");
	const baseSha = await repo.commit("base");
	await repo.git(["push", "-q", "origin", "main"]);

	return { repo, bareDir, baseSha };
};

const cleanupOriginBackedRepo = async (
	fixture: OriginBackedRepo,
): Promise<void> => {
	await cleanupTestRepo(fixture.repo);
	await rm(fixture.bareDir, { recursive: true, force: true });
};

/** Simulates GitHub publishing `refs/pull/<n>/head` for an open PR — same anonymous ref for a same-repo or fork PR. */
const publishPullRequestRef = (
	bareDir: string,
	number: number,
	sha: string,
): Promise<string> =>
	sh(bareDir, ["update-ref", `refs/pull/${number}/head`, sha]);

/** Points `NISI_DATA_DIR` at an isolated temp dir per test, mirroring `@repo/review`'s test fixtures — a shared default would let concurrent test files race on the same worktree paths. */
const withDataDir = (dataDir: string) =>
	Effect.provide(
		ConfigProvider.layer(
			ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
		),
	);

const run = <A, E>(
	effect: Effect.Effect<A, E, BunServices.BunServices>,
	dataDir: string,
): Promise<A> =>
	Effect.runPromise(
		effect.pipe(Effect.provide(BunServices.layer), withDataDir(dataDir)),
	);

/** Runs an effect expected to fail, returning its error value directly rather than an `Exit` to unwrap. */
const runFailure = <A, E>(
	effect: Effect.Effect<A, E, BunServices.BunServices>,
	dataDir: string,
): Promise<E> =>
	Effect.runPromise(
		effect.pipe(
			Effect.flip,
			Effect.provide(BunServices.layer),
			withDataDir(dataDir),
		),
	);

describe("openPullRequestWorktree", () => {
	test("creates a worktree checked out at the PR's ref, and is idempotent on a second call", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);

			const first = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(existsSync(first)).toBe(true);
			expect((await sh(first, ["rev-parse", "HEAD"])).trim()).toBe(
				fixture.baseSha,
			);

			// Move the PR's head forward on origin. If the second call actually
			// re-fetched, the worktree's HEAD would follow it to `advancedSha` — the
			// idempotent short-circuit must leave it exactly where it was instead.
			await fixture.repo.write("b.ts", "advance\n");
			const advancedSha = await fixture.repo.commit("advance");
			// The bare "origin" only has objects that were actually pushed to it —
			// `update-ref` alone can't point at a commit it's never seen.
			await fixture.repo.git(["push", "-q", "origin", "main"]);
			await publishPullRequestRef(fixture.bareDir, 1, advancedSha);

			const second = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(second).toBe(first);
			expect((await sh(second, ["rev-parse", "HEAD"])).trim()).toBe(
				fixture.baseSha,
			);
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("recreates the worktree when its directory was removed outside git, leaving a stale (prunable) registration", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);

			const first = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);

			// `rm -rf`, not `git worktree remove` — git's registration now points at
			// a directory that no longer exists (`prunable`), the exact case the
			// idempotency check has to tell apart from "still a live worktree".
			await rm(first, { recursive: true, force: true });

			const second = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(second).toBe(first);
			expect(existsSync(second)).toBe(true);
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fails with NoOriginRemote when the repo has no origin remote", async () => {
		const repo = await makeTestRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");

			const error = await runFailure(
				openPullRequestWorktree({
					repoRoot: repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(error._tag).toBe("NoOriginRemote");
		} finally {
			await cleanupTestRepo(repo);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fails with PullRequestRefNotFound when origin has no ref for that PR number", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			const error = await runFailure(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 999,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(error._tag).toBe("PullRequestRefNotFound");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fails with WorktreePathOccupied when the target path exists but git has no worktree registered there", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);

			// Properly deregister and remove it, then put an ordinary directory back
			// at the exact same path — occupied, but not a worktree git knows about.
			await sh(fixture.repo.root, ["worktree", "remove", "--force", path]);
			await mkdir(path, { recursive: true });

			const error = await runFailure(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(error._tag).toBe("WorktreePathOccupied");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("reuses the PR's nisi-managed branch when it's already checked out somewhere else, instead of failing with WorktreeBranchInUse", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const elsewhere = await mkdtemp(join(tmpdir(), "nisi-worktree-elsewhere-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			const branch = (
				await sh(path, ["rev-parse", "--abbrev-ref", "HEAD"])
			).trim();

			// Deregister the worktree without deleting its branch, then check that
			// same branch out somewhere `openPullRequestWorktree` doesn't know
			// about — reopening the PR now finds its nisi-managed branch already
			// checked out at a location it never computed itself, and must reuse
			// it rather than trying (and failing) to move the branch.
			await rm(elsewhere, { recursive: true, force: true });
			await sh(fixture.repo.root, ["worktree", "remove", "--force", path]);
			await sh(fixture.repo.root, ["worktree", "add", "-q", elsewhere, branch]);

			const second = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(second).toBe(await realpath(elsewhere));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(elsewhere, { recursive: true, force: true });
		}
	});

	test("reuses the main clone when the PR's own head branch is checked out there, without ever fetching", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			// Deliberately never publish `refs/pull/1/head` — if reuse fell through
			// to the fetch-and-create path, this would fail with
			// `PullRequestRefNotFound` instead of succeeding, which is what makes
			// this test prove the fetch never happens.
			await fixture.repo.git(["checkout", "-b", "feature"]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(path).toBe(await realpath(fixture.repo.root));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("reuses an existing worktree when the PR's own head branch is checked out there, not in the main clone", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const authorWorktree = await mkdtemp(
			join(tmpdir(), "nisi-worktree-author-"),
		);
		try {
			await rm(authorWorktree, { recursive: true, force: true });
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				authorWorktree,
				"feature",
			]);

			// Again, no PR ref published — success here can only come from the
			// reuse path, not a fetch.
			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(path).toBe(await realpath(authorWorktree));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(authorWorktree, { recursive: true, force: true });
		}
	});

	test("places a new worktree next to the repo's existing worktrees when they share a real common parent", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const conventionParent = await mkdtemp(
			join(tmpdir(), "nisi-worktree-convention-"),
		);
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling", fixture.baseSha]);
			const siblingPath = join(conventionParent, "existing-sibling");
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				siblingPath,
				"sibling",
			]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(dirname(path)).toBe(await realpath(conventionParent));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(conventionParent, { recursive: true, force: true });
		}
	});

	test("falls back to the app-data worktree directory when existing worktrees are scattered with no shared parent, rather than guessing an absurd common ancestor", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const scatteredA = await mkdtemp(
			join(tmpdir(), "nisi-worktree-scatter-a-"),
		);
		const scatteredB = await mkdtemp(
			join(tmpdir(), "nisi-worktree-scatter-b-"),
		);
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling-a", fixture.baseSha]);
			await sh(fixture.repo.root, ["branch", "sibling-b", fixture.baseSha]);
			const pathA = join(scatteredA, "wt-a");
			const pathB = join(scatteredB, "wt-b");
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				pathA,
				"sibling-a",
			]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				pathB,
				"sibling-b",
			]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			const expectedParent = join(await realpath(dataDir), "worktrees");
			expect(dirname(path)).toBe(expectedParent);
			expect(dirname(path)).not.toBe("/");
			expect(dirname(path)).not.toBe(await realpath(scatteredA));
			expect(dirname(path)).not.toBe(await realpath(scatteredB));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(scatteredA, { recursive: true, force: true });
			await rm(scatteredB, { recursive: true, force: true });
		}
	});

	test("places a new worktree next to the majority parent even when one stray worktree lives elsewhere", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const conventionParent = await mkdtemp(
			join(tmpdir(), "nisi-worktree-convention-"),
		);
		const strayParent = await mkdtemp(join(tmpdir(), "nisi-worktree-stray-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling-a", fixture.baseSha]);
			await sh(fixture.repo.root, ["branch", "sibling-b", fixture.baseSha]);
			await sh(fixture.repo.root, ["branch", "stray", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "sibling-a"),
				"sibling-a",
			]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "sibling-b"),
				"sibling-b",
			]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(strayParent, "stray"),
				"stray",
			]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(dirname(path)).toBe(await realpath(conventionParent));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(conventionParent, { recursive: true, force: true });
			await rm(strayParent, { recursive: true, force: true });
		}
	});

	test("checks out an existing local branch matching headRef, already at the PR head, instead of creating a nisi-managed branch", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			// A local branch already named `headRef`, sitting at the exact PR
			// head, but not checked out anywhere — step 1 only matches a
			// *checked-out* branch, so without the new fallback this would fetch
			// a redundant `nisi/pr-1/feature` instead of reusing it.
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);

			expect(
				(await sh(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
			).toBe("feature");
			expect((await sh(path, ["rev-parse", "HEAD"])).trim()).toBe(
				fixture.baseSha,
			);
			expect(
				(
					await sh(fixture.repo.root, ["branch", "--list", "nisi/pr-1/feature"])
				).trim(),
			).toBe("");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fast-forwards an existing local branch matching headRef when it's behind the PR head", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			// A local branch at the PR's *old* head, not checked out anywhere.
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);

			// The PR itself moved forward in the meantime.
			await fixture.repo.write("b.ts", "advance\n");
			const advancedSha = await fixture.repo.commit("advance");
			await fixture.repo.git(["push", "-q", "origin", "main"]);
			await publishPullRequestRef(fixture.bareDir, 1, advancedSha);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);

			expect(
				(await sh(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
			).toBe("feature");
			expect((await sh(path, ["rev-parse", "HEAD"])).trim()).toBe(advancedSha);
			// The fast-forward moved the branch itself, not just what this one
			// worktree happens to have checked out.
			expect(
				(await sh(fixture.repo.root, ["rev-parse", "feature"])).trim(),
			).toBe(advancedSha);
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("leaves a diverged local branch untouched and falls back to the nisi-managed branch", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			// A local branch sharing the PR's headRef name, with its own commit
			// the PR head never saw — not an ancestor of the PR head in either
			// direction.
			await sh(fixture.repo.root, [
				"checkout",
				"-q",
				"-b",
				"feature",
				fixture.baseSha,
			]);
			await fixture.repo.write("local-only.ts", "diverged\n");
			const divergedSha = await fixture.repo.commit("diverged, local only");
			await sh(fixture.repo.root, ["checkout", "-q", "main"]);

			// The PR moved forward independently, from the same base.
			await fixture.repo.write("b.ts", "pr-side\n");
			const prHeadSha = await fixture.repo.commit("pr-side");
			await fixture.repo.git(["push", "-q", "origin", "main"]);
			await publishPullRequestRef(fixture.bareDir, 1, prHeadSha);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);

			expect(
				(await sh(path, ["rev-parse", "--abbrev-ref", "HEAD"])).trim(),
			).toBe("nisi/pr-1/feature");
			expect((await sh(path, ["rev-parse", "HEAD"])).trim()).toBe(prHeadSha);
			// The user's own branch must be left exactly where it was.
			expect(
				(await sh(fixture.repo.root, ["rev-parse", "feature"])).trim(),
			).toBe(divergedSha);
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fails with PullRequestRefNotFound even when a local branch already shares headRef's name", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);
			// Deliberately never publish `refs/pull/999/head` — the "branch
			// already exists" path must surface this the same way the plain
			// fetch-and-create path does, not swallow it.

			const error = await runFailure(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 999,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(error._tag).toBe("PullRequestRefNotFound");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("names a worktree placed under an inferred convention dir after headRef, not the old hash-suffixed scheme", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const conventionParent = await mkdtemp(
			join(tmpdir(), "nisi-worktree-convention-"),
		);
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "existing-sibling"),
				"sibling",
			]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(dirname(path)).toBe(await realpath(conventionParent));
			expect(basename(path)).toBe("feature");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(conventionParent, { recursive: true, force: true });
		}
	});

	test("flattens a headRef containing a slash into a single path segment directly under the convention dir", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const conventionParent = await mkdtemp(
			join(tmpdir(), "nisi-worktree-convention-"),
		);
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "existing-sibling"),
				"sibling",
			]);

			// A slash in headRef would otherwise nest the worktree a directory
			// deeper — `dirname()` of that nested path would then poison the
			// majority-parent inference for every later PR, which is what this
			// asserts against by checking the parent dir is exactly the
			// convention dir, not one level below it.
			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feat/nested-thing",
				}),
				dataDir,
			);
			expect(dirname(path)).toBe(await realpath(conventionParent));
			expect(basename(path)).toBe("feat-nested-thing");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(conventionParent, { recursive: true, force: true });
		}
	});

	test("still uses the old disambiguated <repo>-<hash>-pr<n> name when placed under the app-data fallback", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const scatteredA = await mkdtemp(
			join(tmpdir(), "nisi-worktree-scatter-a-"),
		);
		const scatteredB = await mkdtemp(
			join(tmpdir(), "nisi-worktree-scatter-b-"),
		);
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);
			await sh(fixture.repo.root, ["branch", "sibling-a", fixture.baseSha]);
			await sh(fixture.repo.root, ["branch", "sibling-b", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(scatteredA, "wt-a"),
				"sibling-a",
			]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(scatteredB, "wt-b"),
				"sibling-b",
			]);

			const path = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(dirname(path)).toBe(join(await realpath(dataDir), "worktrees"));
			// Bare `headRef` isn't unique enough across every repo the app-data
			// fallback is shared by, so the fallback keeps the old
			// hash-suffixed, PR-number-suffixed name rather than switching to
			// `headRef` too.
			expect(basename(path)).not.toBe("feature");
			expect(basename(path)).toMatch(/^.+-[0-9a-f]{10}-pr1$/);
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(scatteredA, { recursive: true, force: true });
			await rm(scatteredB, { recursive: true, force: true });
		}
	});

	test("fails with WorktreePathOccupied when a live worktree is already registered at the target path but checked out on an unrelated branch", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const conventionParent = await mkdtemp(
			join(tmpdir(), "nisi-worktree-convention-"),
		);
		try {
			await sh(fixture.repo.root, ["branch", "sibling", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "existing-sibling"),
				"sibling",
			]);

			// Something else entirely is already checked out at the exact path
			// `headRef: "feature"` would compute under this convention dir —
			// neither `feature` itself nor this PR's nisi-managed branch. A bare
			// `headRef` name is less collision-proof than the old hash-suffixed
			// scheme (two PRs from different forks can share a head branch
			// name), so reusing it would silently hand back the wrong PR's
			// worktree.
			await sh(fixture.repo.root, ["branch", "unrelated", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				join(conventionParent, "feature"),
				"unrelated",
			]);

			const error = await runFailure(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			expect(error._tag).toBe("WorktreePathOccupied");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(conventionParent, { recursive: true, force: true });
		}
	});
});

describe("revalidateWorktreePath", () => {
	test("returns the path unchanged, without consulting git at all, when it's still on disk", async () => {
		const repo = await makeTestRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");

			// `resolveSourceRepoRoot` fails outright if evaluated at all — if the
			// fast path did anything besides `stat(path)`, this would fail rather
			// than short-circuit.
			const result = await run(
				revalidateWorktreePath({
					path: repo.root,
					headRef: "main",
					number: null,
					resolveSourceRepoRoot: Effect.die(
						"resolveSourceRepoRoot should never run when path exists",
					),
				}),
				dataDir,
			);
			expect(result).toBe(repo.root);
		} finally {
			await cleanupTestRepo(repo);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("re-resolves a moved worktree by finding its branch in the source repo's own `git worktree list`", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const oldLocation = await mkdtemp(join(tmpdir(), "nisi-worktree-old-"));
		const newParent = await mkdtemp(join(tmpdir(), "nisi-worktree-new-"));
		try {
			await rm(oldLocation, { recursive: true, force: true });
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				oldLocation,
				"feature",
			]);

			// Simulates what `wt`/worktrunk (or a plain `git worktree move`) did in
			// the field: the worktree's checkout relocates, git's own
			// registration follows it, but nothing tells nisi the path it
			// persisted is now stale.
			const newLocation = join(newParent, "relocated");
			await sh(fixture.repo.root, [
				"worktree",
				"move",
				oldLocation,
				newLocation,
			]);
			expect(existsSync(oldLocation)).toBe(false);

			const result = await run(
				revalidateWorktreePath({
					path: oldLocation,
					headRef: "feature",
					number: null,
					resolveSourceRepoRoot: Effect.succeed(fixture.repo.root),
				}),
				dataDir,
			);
			expect(result).toBe(await realpath(newLocation));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(oldLocation, { recursive: true, force: true });
			await rm(newParent, { recursive: true, force: true });
		}
	});

	test("re-resolves a moved PR worktree by its nisi-managed branch when headRef itself isn't registered", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const newParent = await mkdtemp(join(tmpdir(), "nisi-worktree-new-"));
		try {
			await publishPullRequestRef(fixture.bareDir, 1, fixture.baseSha);

			const oldLocation = await run(
				openPullRequestWorktree({
					repoRoot: fixture.repo.root,
					number: 1,
					headRef: "feature",
				}),
				dataDir,
			);
			// `openPullRequestWorktree` created this on the nisi-managed
			// `nisi/pr-1/feature` branch, not a local `feature` branch — the
			// PR's own `headRef` alone would never match this registration.
			const newLocation = join(newParent, "relocated");
			await sh(fixture.repo.root, [
				"worktree",
				"move",
				oldLocation,
				newLocation,
			]);

			const result = await run(
				revalidateWorktreePath({
					path: oldLocation,
					headRef: "feature",
					number: 1,
					resolveSourceRepoRoot: Effect.succeed(fixture.repo.root),
				}),
				dataDir,
			);
			expect(result).toBe(await realpath(newLocation));
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
			await rm(newParent, { recursive: true, force: true });
		}
	});

	test("fails with WorktreeRelocationFailed when the worktree was genuinely removed, not just moved", async () => {
		const fixture = await makeOriginBackedRepo();
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		try {
			await sh(fixture.repo.root, ["branch", "feature", fixture.baseSha]);
			const location = await mkdtemp(join(tmpdir(), "nisi-worktree-gone-"));
			await rm(location, { recursive: true, force: true });
			await sh(fixture.repo.root, [
				"worktree",
				"add",
				"-q",
				location,
				"feature",
			]);

			// A real removal, not an out-of-band `rm -rf` — deregisters the
			// worktree entirely rather than leaving a `prunable` entry behind.
			await sh(fixture.repo.root, ["worktree", "remove", "--force", location]);

			const error = await runFailure(
				revalidateWorktreePath({
					path: location,
					headRef: "feature",
					number: null,
					resolveSourceRepoRoot: Effect.succeed(fixture.repo.root),
				}),
				dataDir,
			);
			expect(error._tag).toBe("WorktreeRelocationFailed");
		} finally {
			await cleanupOriginBackedRepo(fixture);
			await rm(dataDir, { recursive: true, force: true });
		}
	});

	test("fails with WorktreeRelocationFailed when there's no source repo to consult at all", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-worktree-data-"));
		const location = await mkdtemp(join(tmpdir(), "nisi-worktree-gone-"));
		try {
			await rm(location, { recursive: true, force: true });

			const error = await runFailure(
				revalidateWorktreePath({
					path: location,
					headRef: "main",
					number: null,
					resolveSourceRepoRoot: Effect.succeed(null),
				}),
				dataDir,
			);
			expect(error._tag).toBe("WorktreeRelocationFailed");
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});
