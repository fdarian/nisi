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

describe("resolveUnpushedCommits", () => {
	test("fails with NoRemoteRefToCompare when there's no origin and no upstream at all", async () => {
		const repo = await makeTestRepo();
		try {
			await repo.write("a.ts", "hello\n");
			await repo.commit("base");

			const exit = await runExit(resolveUnpushedCommits(repo.root, null));
			expect(exit._tag).toBe("Failure");
		} finally {
			await cleanupTestRepo(repo);
		}
	});

	test("counts 0 via `@{upstream}` when HEAD is fully pushed", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git([
				"branch",
				"--set-upstream-to=origin/main",
				"main",
			]);

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

	test("counts commits made locally after the last push, via `@{upstream}`", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git([
				"branch",
				"--set-upstream-to=origin/main",
				"main",
			]);
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("unpushed 1");
			await fixture.repo.write("c.ts", "two\n");
			await fixture.repo.commit("unpushed 2");

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

	test("falls back to origin/<branch> when no `@{upstream}` is configured", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			// Deliberately no `--set-upstream-to` — `git push` above didn't record
			// one either, since it wasn't given `-u`.
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("unpushed");

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
			expect(result.remoteRef).toBe("origin/main");
			expect(result.ahead).toBe(1);
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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
			const withoutBase = await run(
				resolveUnpushedCommits(fixture.repo.root, null),
			);
			expect(withoutBase.origin).toBeNull();

			const missingBase = await run(
				resolveUnpushedCommits(fixture.repo.root, "nope"),
			);
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

			const result = await run(
				resolveUnpushedCommits(fixture.repo.root, "main"),
			);
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
			const result = await run(
				resolveUnpushedCommits(fixture.repo.root, "main"),
			);
			expect(result.origin).toEqual({ baseRef: "main", count: 0, commits: [] });
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("fails with NoRemoteRefToCompare when origin exists but has no ref for this branch", async () => {
		const fixture = await makeOriginBackedRepo();
		try {
			await fixture.repo.git(["checkout", "-q", "-b", "feature"]);
			await fixture.repo.write("b.ts", "one\n");
			await fixture.repo.commit("on feature");

			const exit = await runExit(
				resolveUnpushedCommits(fixture.repo.root, null),
			);
			expect(exit._tag).toBe("Failure");
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
			expect(result.ahead).toBe(0);
			expect(result.behind).toBe(1);
			expect(result.commits).toEqual([]);
			expect(result.diverged).toBe(false);
		} finally {
			await cleanupOriginBackedRepo(fixture);
		}
	});

	test("fetches the remote branch first, so a stale tracking ref doesn't report pushed commits", async () => {
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
				"refs/remotes/origin/feature",
				first,
			]);

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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

			const result = await run(resolveUnpushedCommits(fixture.repo.root, null));
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
