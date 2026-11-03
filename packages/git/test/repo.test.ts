import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	resolveHeadSha,
	resolveMergeBase,
	resolveUnpushedCommits,
} from "../src/repo.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const runExit = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(
		Effect.exit(effect.pipe(Effect.provide(BunServices.layer))),
	);

type OriginBackedRepo = {
	readonly repo: TestRepo;
	readonly bareDir: string;
};

/** A bare "origin" plus a working repo with `origin` configured and `main` pushed — the minimum shape `resolveUnpushedCommits` needs a real remote ref to compare against. */
const makeOriginBackedRepo = async (): Promise<OriginBackedRepo> => {
	const bareDir = await mkdtemp(join(tmpdir(), "nisi-repo-origin-"));
	await Bun.spawn(["git", "init", "-q", "--bare", "-b", "main"], {
		cwd: bareDir,
	}).exited;

	const repo = await makeTestRepo();
	await repo.git(["remote", "add", "origin", bareDir]);
	await repo.write("a.ts", "hello\n");
	await repo.commit("base");
	await repo.git(["push", "-q", "origin", "main"]);

	return { repo, bareDir };
};

const cleanupOriginBackedRepo = async (
	fixture: OriginBackedRepo,
): Promise<void> => {
	await cleanupTestRepo(fixture.repo);
	await rm(fixture.bareDir, { recursive: true, force: true });
};

const PR_NUMBER = 1;

/**
 * `resolveUnpushedCommits` for the checked-out branch as the PR's head
 * branch, after pointing the bare origin's `refs/pull/1/head` at that
 * branch on origin — what GitHub does for a PR whose head is that branch.
 * A branch absent from origin leaves the PR ref unpublished.
 */
const check = async (
	fixture: OriginBackedRepo,
	baseRef: string | null = null,
) => {
	const headRef = (await fixture.repo.git(["branch", "--show-current"])).trim();
	await publishPrHead(fixture, headRef);
	return run(
		resolveUnpushedCommits(fixture.repo.root, baseRef, {
			number: PR_NUMBER,
			headRef,
		}),
	);
};

/** Points the bare origin's `refs/pull/1/head` at `branch` on origin, if origin has it. */
const publishPrHead = async (fixture: OriginBackedRepo, branch: string) => {
	const proc = Bun.spawn(
		[
			"git",
			"update-ref",
			`refs/pull/${PR_NUMBER}/head`,
			`refs/heads/${branch}`,
		],
		{ cwd: fixture.bareDir, stdout: "pipe", stderr: "pipe" },
	);
	await proc.exited;
};

describe("resolveUnpushedCommits", () => {
	test("fails when the PR head ref can't be fetched from origin", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			const exit = await runExit(
				resolveUnpushedCommits(fixture.repo.root, null, {
					number: PR_NUMBER,
					headRef: "main",
				}),
			);
			expect(exit._tag).toBe("Failure");
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("counts 0 for a branch cut from origin/main whose commits are all on the PR head", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git([
				"checkout",
				"-q",
				"-b",
				"feature",
				"--track",
				"origin/main",
			]);
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("pr commit 1");
			await fixture.repo.write("c.ts", "two\n");
			await fixture.repo.commit("pr commit 2");
			await fixture.repo.git(["push", "-q", "origin", "HEAD:feature"]);

			const result = await check(fixture, "main");
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(0);
			expect(result.behind).toBe(0);
			expect(result.commits).toEqual([]);
			expect(result.origin?.count).toBe(2);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("counts a commit the PR head lacks, even when the upstream is origin/main", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git([
				"checkout",
				"-q",
				"-b",
				"feature",
				"--track",
				"origin/main",
			]);
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("on the PR");
			await fixture.repo.git(["push", "-q", "origin", "HEAD:feature"]);
			await fixture.repo.write("c.ts", "two\n");
			await fixture.repo.commit("not pushed");

			const result = await check(fixture, "main");
			expect(result.ahead).toBe(1);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"not pushed",
			]);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("compares against the PR head of a nisi worktree branch, named after headRef", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git([
				"checkout",
				"-q",
				"-b",
				"nisi/pr-1/feature",
				"--track",
				"origin/main",
			]);
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("on the PR");
			await fixture.repo.git(["push", "-q", "origin", "HEAD:feature"]);
			await publishPrHead(fixture, "feature");

			const result = await run(
				resolveUnpushedCommits(fixture.repo.root, null, {
					number: PR_NUMBER,
					headRef: "feature",
				}),
			);
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(0);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("fails with NotOnPullRequestBranch when the checked-out branch isn't the PR's", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "other"]);
			await publishPrHead(fixture, "main");

			const exit = await runExit(
				resolveUnpushedCommits(fixture.repo.root, null, {
					number: PR_NUMBER,
					headRef: "feature",
				}),
			);
			expect(exit._tag).toBe("Failure");
			expect(JSON.stringify(exit)).toContain("NotOnPullRequestBranch");
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("fails with NotOnPullRequestBranch when HEAD is detached", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "--detach"]);
			await publishPrHead(fixture, "main");

			const exit = await runExit(
				resolveUnpushedCommits(fixture.repo.root, null, {
					number: PR_NUMBER,
					headRef: "main",
				}),
			);
			expect(exit._tag).toBe("Failure");
			expect(JSON.stringify(exit)).toContain("NotOnPullRequestBranch");
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("counts 0 when HEAD is fully pushed", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			const result = await check(fixture);
			expect(result).toEqual({
				remoteRef: "origin/main",
				ahead: 0,
				behind: 0,
				commits: [],
				diverged: false,
				origin: null,
			});
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("counts commits made locally after the last push", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("unpushed 1");
			await fixture.repo.write("c.ts", "two\n");
			await fixture.repo.commit("unpushed 2");

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/main");
			expect(result.ahead).toBe(2);
			expect(result.behind).toBe(0);
			expect(result.diverged).toBe(false);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"unpushed 2",
				"unpushed 1",
			]);
			expect(result.commits[0]?.sha).toMatch(/^[0-9a-f]{40}$/);
			expect(Date.parse(result.commits[0]?.authoredAt ?? "")).not.toBeNaN();
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("reports commits only the remote has as `behind`", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.write("b.ts", "remote\n");
			await fixture.repo.commit("remote only");
			await fixture.repo.git(["push", "-q", "origin", "main"]);
			await fixture.repo.git(["reset", "-q", "--hard", "HEAD~1"]);
			await fixture.repo.write("c.ts", "local\n");
			await fixture.repo.commit("local only");

			const result = await check(fixture);
			expect(result.ahead).toBe(1);
			expect(result.behind).toBe(1);
			expect(result.diverged).toBe(true);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"local only",
			]);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("lists at most 5 unpushed commits, newest first, while `ahead` stays exact", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			for (let index = 1; index <= 7; index++) {
				await fixture.repo.write(`f${index}.ts`, `${index}\n`);
				await fixture.repo.commit(`unpushed ${index}`);
			}

			const result = await check(fixture);
			expect(result.ahead).toBe(7);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"unpushed 7",
				"unpushed 6",
				"unpushed 5",
				"unpushed 4",
				"unpushed 3",
			]);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("keeps odd characters in subjects intact", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit('fix: handle | and "quotes" and tabs\tthere');

			const result = await check(fixture);
			expect(result.commits[0]?.subject).toBe(
				'fix: handle | and "quotes" and tabs\tthere',
			);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("origin is null when baseRef is null or origin/<baseRef> doesn't exist", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			const withoutBase = await check(fixture);
			expect(withoutBase.origin).toBeNull();

			const missingBase = await check(fixture, "nope");
			expect(missingBase.origin).toBeNull();
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("origin lists what the remote branch holds beyond origin/<baseRef>", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			for (let index = 1; index <= 7; index++) {
				await fixture.repo.write(`f${index}.ts`, `${index}\n`);
				await fixture.repo.commit(`on origin ${index}`);
			}
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);
			await fixture.repo.write("local.ts", "local\n");
			await fixture.repo.commit("local only");

			const result = await check(fixture, "main");
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(1);
			expect(result.origin?.baseRef).toBe("main");
			expect(result.origin?.count).toBe(7);
			expect(result.origin?.commits.map((commit) => commit.subject)).toEqual([
				"on origin 7",
				"on origin 6",
				"on origin 5",
				"on origin 4",
				"on origin 3",
			]);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("origin is empty when the remote branch is the base itself", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			const result = await check(fixture, "main");
			expect(result.origin).toEqual({ baseRef: "main", count: 0, commits: [] });
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});
});

/** A second working clone of `bareDir` — plays "GitHub" (or a teammate) rewriting the remote behind the local repo's back. */
const makeOtherClone = async (bareDir: string): Promise<TestRepo> => {
	const other = await makeTestRepo();
	await other.git(["remote", "add", "origin", bareDir]);
	await other.git(["fetch", "-q", "origin"]);
	await other.git(["checkout", "-q", "-B", "main", "origin/main"]);
	return other;
};

describe("resolveUnpushedCommits — remote diverged from the local branch", () => {
	test("a plain push-ahead of 2 reports diverged: false", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("f.ts", "one\n");
			await fixture.repo.commit("f1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);
			await fixture.repo.write("g.ts", "two\n");
			await fixture.repo.commit("f2");
			await fixture.repo.write("h.ts", "three\n");
			await fixture.repo.commit("f3");

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(2);
			expect(result.behind).toBe(0);
			expect(result.diverged).toBe(false);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"f3",
				"f2",
			]);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("behind-only is not diverged and keeps the plain counts", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.write("b.ts", "remote\n");
			await fixture.repo.commit("remote only");
			await fixture.repo.git(["push", "-q", "origin", "main"]);
			await fixture.repo.git(["reset", "-q", "--hard", "HEAD~1"]);

			const result = await check(fixture);
			expect(result.ahead).toBe(0);
			expect(result.behind).toBe(1);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(false);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("refetches the PR head, so a stale local copy doesn't report pushed commits", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("f.ts", "one\n");
			const first = await fixture.repo.commit("f1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);
			await fixture.repo.write("g.ts", "two\n");
			await fixture.repo.commit("f2");
			await fixture.repo.git(["push", "-q", "origin", "feature"]);
			await fixture.repo.git([
				"update-ref",
				`refs/nisi/pr/${PR_NUMBER}/head`,
				first,
			]);

			const result = await check(fixture);
			expect(result.ahead).toBe(0);
			expect(result.diverged).toBe(false);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("remote rebased onto a moved main, local stale: nothing missing", async () => {
		const fixture = await makeOriginBackedRepo();
		const other = await makeOtherClone(fixture.bareDir);
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("f.ts", "one\n");
			await fixture.repo.commit("f1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);

			await other.write("m.ts", "main moved\n");
			await other.commit("main moves");
			await other.git(["push", "-q", "origin", "main"]);
			await other.git(["fetch", "-q", "origin", "feature"]);
			await other.git(["checkout", "-q", "-b", "feature", "origin/feature"]);
			await other.git(["rebase", "-q", "main"]);
			await other.git(["push", "-q", "--force", "origin", "feature"]);

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(0);
			expect(result.behind).toBe(2);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(true);
		} finally {
			await cleanupTestRepo(other);
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("parent PR squash-merged and child rebased remotely: parent and child commits are all contained", async () => {
		const fixture = await makeOriginBackedRepo();
		const other = await makeOtherClone(fixture.bareDir);
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "parent"]);
			await fixture.repo.write("p.ts", "p1\n");
			await fixture.repo.commit("p1");
			await fixture.repo.write("p.ts", "p1\np2\n");
			await fixture.repo.commit("p2");
			await fixture.repo.git(["push", "-q", "origin", "parent"]);
			await fixture.repo.git(["checkout", "-q", "-b", "child"]);
			await fixture.repo.write("c.ts", "c1\n");
			await fixture.repo.commit("c1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "child"]);

			await other.git(["fetch", "-q", "origin"]);
			await other.git([
				"-c",
				"merge.ff=true",
				"merge",
				"-q",
				"--squash",
				"origin/parent",
			]);
			await other.git(["commit", "-q", "-m", "squash parent"]);
			await other.git(["push", "-q", "origin", "main"]);
			await other.git(["checkout", "-q", "-b", "child", "origin/child"]);
			await other.git(["rebase", "-q", "--onto", "main", "origin/parent"]);
			await other.git(["push", "-q", "--force", "origin", "child"]);

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/child");
			expect(result.ahead).toBe(0);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(true);
		} finally {
			await cleanupTestRepo(other);
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("parent commit whose lines a later parent commit removes: replaying it alone must not flag it", async () => {
		const fixture = await makeOriginBackedRepo();
		const other = await makeOtherClone(fixture.bareDir);
		try {
			const lines = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8"];
			await fixture.repo.write("q.ts", `${lines.join("\n")}\n`);
			await fixture.repo.commit("add q");
			await fixture.repo.git(["push", "-q", "origin", "main"]);

			await fixture.repo.git(["checkout", "-q", "-b", "parent"]);
			const withIntermediate = [...lines];
			withIntermediate.splice(2, 0, "intermediate");
			await fixture.repo.write("q.ts", `${withIntermediate.join("\n")}\n`);
			await fixture.repo.commit("p1 adds intermediate line");
			const final = [...lines.slice(0, 7), "l8 changed"];
			await fixture.repo.write("q.ts", `${final.join("\n")}\n`);
			await fixture.repo.commit("p2 removes it and edits the tail");
			await fixture.repo.git(["push", "-q", "origin", "parent"]);
			await fixture.repo.git(["checkout", "-q", "-b", "child"]);
			await fixture.repo.write("c.ts", "c1\n");
			await fixture.repo.commit("c1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "child"]);

			await other.git(["fetch", "-q", "origin"]);
			await other.git(["merge", "-q", "--ff-only", "origin/main"]);
			await other.git([
				"-c",
				"merge.ff=true",
				"merge",
				"-q",
				"--squash",
				"origin/parent",
			]);
			await other.git(["commit", "-q", "-m", "squash parent"]);
			await other.git(["push", "-q", "origin", "main"]);
			await other.git(["checkout", "-q", "-b", "child", "origin/child"]);
			await other.git(["rebase", "-q", "--onto", "main", "origin/parent"]);
			await other.git(["push", "-q", "--force", "origin", "child"]);

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/child");
			expect(result.ahead).toBe(0);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(true);
		} finally {
			await cleanupTestRepo(other);
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("a new local commit on top of the pre-rebase branch is still counted and listed", async () => {
		const fixture = await makeOriginBackedRepo();
		const other = await makeOtherClone(fixture.bareDir);
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("f.ts", "one\n");
			await fixture.repo.commit("f1");
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);

			await other.write("m.ts", "main moved\n");
			await other.commit("main moves");
			await other.git(["push", "-q", "origin", "main"]);
			await other.git(["fetch", "-q", "origin", "feature"]);
			await other.git(["checkout", "-q", "-b", "feature", "origin/feature"]);
			await other.git(["rebase", "-q", "main"]);
			await other.git(["push", "-q", "--force", "origin", "feature"]);

			await fixture.repo.write("g.ts", "brand new lines\n");
			await fixture.repo.commit("local fix");

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(1);
			expect(result.commits.map((commit) => commit.subject)).toEqual([
				"local fix",
			]);
			expect(result.diverged).toBe(true);
		} finally {
			await cleanupTestRepo(other);
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("lines the remote has since reformatted count as superseded, not missing", async () => {
		const fixture = await makeOriginBackedRepo();
		const other = await makeOtherClone(fixture.bareDir);
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("x.ts", "alpha\nbeta\ngamma\n");
			await fixture.repo.commit("x base");
			await fixture.repo.write("x.ts", "alpha\nbeta changed\ngamma\n");
			await fixture.repo.commit("x tweak");
			await fixture.repo.git(["push", "-q", "-u", "origin", "feature"]);

			await other.git(["fetch", "-q", "origin", "feature"]);
			await other.git(["checkout", "-q", "-b", "feature", "origin/feature"]);
			await other.git(["reset", "-q", "--hard", "main"]);
			await other.write("x.ts", "ALPHA\nBETA CHANGED\nGAMMA\n");
			await other.commit("x reformatted");
			await other.git(["push", "-q", "--force", "origin", "feature"]);

			const result = await check(fixture);
			expect(result.remoteRef).toBe("origin/feature");
			expect(result.ahead).toBe(0);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(true);
		} finally {
			await cleanupTestRepo(other);
			await cleanupOriginBackedRepo(fixture);
		}
	});
});

describe("resolveHeadSha / resolveMergeBase — explicit ref, not just HEAD", () => {
	test("resolveHeadSha defaults to HEAD but resolves any other ref given explicitly", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "on main\n");
			const mainSha = await repo.commit("on main");

			await repo.git(["checkout", "-q", "-b", "feature"]);
			await repo.write("a.ts", "on feature\n");
			const featureSha = await repo.commit("on feature");

			// HEAD is "feature" right now — the default must follow it.
			expect(await run(resolveHeadSha(repo.root))).toBe(featureSha);
			// An explicit ref resolves on its own terms, regardless of HEAD.
			expect(await run(resolveHeadSha(repo.root, "main"))).toBe(mainSha);
			expect(await run(resolveHeadSha(repo.root, "feature"))).toBe(featureSha);
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("resolveMergeBase's headRef defaults to HEAD but accepts an explicit second ref", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("base.txt", "base\n");
			const base = await repo.commit("base");

			await repo.git(["checkout", "-q", "-b", "feature-a"]);
			await repo.write("a.ts", "a content\n");
			await repo.commit("on feature-a");

			await repo.git(["checkout", "-q", base, "-b", "feature-b"]);
			await repo.write("b.ts", "b content\n");
			await repo.commit("on feature-b");

			// HEAD is "feature-b" right now — the default second arg follows it.
			expect(await run(resolveMergeBase(repo.root, "feature-a"))).toBe(base);
			// Naming "feature-b" explicitly gives the identical answer here
			// (both branches share the same merge-base), but exercises the
			// explicit path rather than relying on it coinciding with HEAD.
			expect(
				await run(resolveMergeBase(repo.root, "feature-a", "feature-b")),
			).toBe(base);
		} finally {
			await cleanupTestRepo(repo);
		}
	});
});
