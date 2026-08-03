import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { ConfigProvider, Effect } from "effect";
import { openPullRequestWorktree } from "../src/worktree.ts";
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
});
