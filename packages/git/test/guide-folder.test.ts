import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Exit, Layer, Option } from "effect";
import {
	type CommitPullRequest,
	checkoutGuideFolder,
	GitHub,
	type GitHubShape,
	GuideFolderUnresolvable,
	sessionGuideFolder,
} from "../src/index.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

const guidesDir = "/data/guides";

const repos: TestRepo[] = [];
const extraDirs: string[] = [];

afterEach(async () => {
	await Promise.all(repos.splice(0).map(cleanupTestRepo));
	await Promise.all(
		extraDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

const repoWith = async (origin?: string) => {
	const repo = await makeTestRepo();
	repos.push(repo);
	await repo.write("a.txt", "a");
	await repo.commit("init");
	if (origin !== undefined) await repo.git(["remote", "add", "origin", origin]);
	return repo;
};

const githubReturning = (
	pulls: ReadonlyArray<CommitPullRequest>,
	calls: Array<string> = [],
) =>
	Layer.succeed(GitHub, {
		pullRequestsContainingCommit: (
			_cwd: string,
			owner: string,
			repo: string,
			sha: string,
		) => {
			calls.push(`${owner}/${repo}@${sha}`);
			return Effect.succeed(pulls);
		},
	} as unknown as GitHubShape);

const run = <A, E>(
	effect: Effect.Effect<A, E, GitHub | BunServices.BunServices>,
	pulls: ReadonlyArray<CommitPullRequest> = [],
	calls: Array<string> = [],
) =>
	Effect.runPromise(
		effect.pipe(
			Effect.provide(githubReturning(pulls, calls)),
			Effect.provide(BunServices.layer),
		),
	);

const runExit = <A, E>(
	effect: Effect.Effect<A, E, GitHub | BunServices.BunServices>,
	pulls: ReadonlyArray<CommitPullRequest> = [],
	calls: Array<string> = [],
) =>
	Effect.runPromiseExit(
		effect.pipe(
			Effect.provide(githubReturning(pulls, calls)),
			Effect.provide(BunServices.layer),
		),
	);

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E => {
	if (!Exit.isFailure(exit)) throw new Error("expected a failure");
	return Option.getOrThrow(Exit.findErrorOption(exit));
};

describe("repo key", () => {
	test("is the origin's owner/repo, lowercased, whatever the URL form", async () => {
		const https = await repoWith("https://github.com/Fdarian/NISI.git");
		const ssh = await repoWith("git@github.com:fdarian/nisi.git");
		const expected = join(guidesDir, "fdarian/nisi", "main");

		expect(await run(sessionGuideFolder(guidesDir, https.root, "main"))).toBe(
			expected,
		);
		expect(await run(sessionGuideFolder(guidesDir, ssh.root, "main"))).toBe(
			expected,
		);
	});

	test("without an origin is local/<16 hex of the common dir>, shared by its worktrees", async () => {
		const repo = await repoWith();
		const worktreeParent = await mkdtemp(join(tmpdir(), "nisi-guide-wt-"));
		extraDirs.push(worktreeParent);
		const worktree = join(await realpath(worktreeParent), "wt");
		await repo.git(["worktree", "add", "-q", "-b", "other", worktree]);

		const main = await run(sessionGuideFolder(guidesDir, repo.root, "main"));
		const linked = await run(sessionGuideFolder(guidesDir, worktree, "main"));

		expect(main).toMatch(/^\/data\/guides\/local\/[0-9a-f]{16}\/main$/);
		expect(linked).toBe(main);
	});

	test("two origin-less repos get different keys", async () => {
		const one = await repoWith();
		const two = await repoWith();

		expect(await run(sessionGuideFolder(guidesDir, one.root, "main"))).not.toBe(
			await run(sessionGuideFolder(guidesDir, two.root, "main")),
		);
	});

	test("an origin that is not owner/repo falls back to the local key", async () => {
		const repo = await repoWith("not-a-url");

		expect(await run(sessionGuideFolder(guidesDir, repo.root, "main"))).toMatch(
			/\/local\/[0-9a-f]{16}\/main$/,
		);
	});
});

describe("branch segment", () => {
	test("encodes slashes so a and a/b are siblings, not nested", async () => {
		const repo = await repoWith("https://github.com/o/r.git");

		const plain = await run(sessionGuideFolder(guidesDir, repo.root, "a"));
		const slashed = await run(sessionGuideFolder(guidesDir, repo.root, "a/b"));

		expect(plain).toBe(join(guidesDir, "o/r", "a"));
		expect(slashed).toBe(join(guidesDir, "o/r", "a%2Fb"));
	});

	test("nisi/pr-<n>/<headRef> is the PR's own head ref", async () => {
		const repo = await repoWith("https://github.com/o/r.git");

		expect(
			await run(
				sessionGuideFolder(guidesDir, repo.root, "nisi/pr-12/feature/x"),
			),
		).toBe(await run(sessionGuideFolder(guidesDir, repo.root, "feature/x")));
	});

	test("a branch that merely starts with nisi/ is left alone", async () => {
		const repo = await repoWith("https://github.com/o/r.git");

		expect(
			await run(sessionGuideFolder(guidesDir, repo.root, "nisi/pr-x/y")),
		).toBe(join(guidesDir, "o/r", "nisi%2Fpr-x%2Fy"));
	});
});

describe("sessionGuideFolder", () => {
	test("a detached branch session has no folder", async () => {
		const repo = await repoWith("https://github.com/o/r.git");

		expect(
			await run(sessionGuideFolder(guidesDir, repo.root, "HEAD")),
		).toBeNull();
	});
});

describe("checkoutGuideFolder", () => {
	test("uses the current branch without asking GitHub", async () => {
		const repo = await repoWith("https://github.com/o/r.git");
		await repo.git(["switch", "-q", "-c", "feature/y"]);
		const calls: Array<string> = [];

		expect(
			await run(checkoutGuideFolder(guidesDir, repo.root), [], calls),
		).toBe(join(guidesDir, "o/r", "feature%2Fy"));
		expect(calls).toEqual([]);
	});

	describe("when detached", () => {
		const detached = async (origin?: string) => {
			const repo = await repoWith(origin);
			const sha = (await repo.git(["rev-parse", "HEAD"])).trim();
			await repo.git(["checkout", "-q", "--detach"]);
			return { repo, sha };
		};
		const pull = (
			number: number,
			headRef: string,
			state: CommitPullRequest["state"] = "OPEN",
		): CommitPullRequest => ({ number, headRef, state });

		test("uses the head ref of the one open PR containing HEAD", async () => {
			const { repo, sha } = await detached("https://github.com/O/R.git");
			const calls: Array<string> = [];

			const folder = await run(
				checkoutGuideFolder(guidesDir, repo.root),
				[pull(3, "feature/z"), pull(2, "old", "CLOSED")],
				calls,
			);

			expect(folder).toBe(join(guidesDir, "o/r", "feature%2Fz"));
			expect(calls).toEqual([`O/R@${sha}`]);
		});

		test("fails with advice when no open PR contains HEAD", async () => {
			const { repo } = await detached("https://github.com/o/r.git");

			const error = failureOf(
				await runExit(checkoutGuideFolder(guidesDir, repo.root), [
					pull(2, "old", "CLOSED"),
				]),
			);

			expect(error).toBeInstanceOf(GuideFolderUnresolvable);
			expect((error as GuideFolderUnresolvable).message).toContain(
				"no open PR",
			);
			expect((error as GuideFolderUnresolvable).message).toContain("Check out");
		});

		test("fails naming every PR when several open ones contain HEAD", async () => {
			const { repo } = await detached("https://github.com/o/r.git");

			const error = failureOf(
				await runExit(checkoutGuideFolder(guidesDir, repo.root), [
					pull(3, "a"),
					pull(4, "b"),
				]),
			);

			expect(error).toBeInstanceOf(GuideFolderUnresolvable);
			expect((error as GuideFolderUnresolvable).message).toContain("#3, #4");
		});

		test("fails without asking GitHub when there is no origin", async () => {
			const { repo } = await detached();
			const calls: Array<string> = [];

			const error = failureOf(
				await runExit(
					checkoutGuideFolder(guidesDir, repo.root),
					[pull(3, "a")],
					calls,
				),
			);

			expect(error).toBeInstanceOf(GuideFolderUnresolvable);
			expect(calls).toEqual([]);
		});
	});
});
