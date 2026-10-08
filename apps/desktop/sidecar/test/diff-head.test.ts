import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Result } from "effect";
import { resolveDiffHead, validateHeadRef } from "../diff-head.ts";

/** Runs real `git` for test setup — the code under test uses its own Effect-based runner. */
const sh = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
};

const makeTestRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "nisi-diff-head-repo-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);
	await Bun.write(join(root, "a.ts"), "hello\n");
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", "base"]);
	return root;
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const runResult = <A, E>(
	effect: Effect.Effect<A, E, BunServices.BunServices>,
) =>
	Effect.runPromise(
		Effect.result(effect.pipe(Effect.provide(BunServices.layer))),
	);

describe("resolveDiffHead", () => {
	test("a PR-backed session is worktree-eligible while the PR's head is still unknown, regardless of what's checked out", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "some-other-branch"]);

			const result = await run(
				resolveDiffHead(repoRoot, "feature-from-a-fork", {
					number: 7,
					headSha: undefined,
					merged: false,
				}),
			);
			expect(result).toEqual({ headRef: undefined, worktreeEligible: true });
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("a plain branch session is worktree-eligible when headRef matches the actual checkout", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);

			const result = await run(resolveDiffHead(repoRoot, "feature", null));
			expect(result).toEqual({ headRef: undefined, worktreeEligible: true });
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("an explicit head that was never checked out is ineligible and pinned to that ref", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature-a"]);
			await sh(repoRoot, ["checkout", "-q", "main", "-b", "feature-b"]);
			// Actual checkout is "feature-b" — the session diffs feature-a..? or
			// just names "feature-a" as its head, which was never checked out.
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);

			const result = await run(resolveDiffHead(repoRoot, "feature-a", null));
			expect(result).toEqual({
				headRef: "feature-a",
				worktreeEligible: false,
			});
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("an ordinary session goes ineligible the moment the caller checks out a different branch", async () => {
		const repoRoot = await makeTestRepo();
		try {
			// Session opened while "feature" was checked out — headRef == "feature".
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			// The caller drifts away mid-session.
			await sh(repoRoot, ["checkout", "-q", "main"]);

			const result = await run(resolveDiffHead(repoRoot, "feature", null));
			expect(result).toEqual({ headRef: "feature", worktreeEligible: false });
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("self-heals back to eligible once the caller checks the named head back out", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await sh(repoRoot, ["checkout", "-q", "main"]);
			expect(
				(await run(resolveDiffHead(repoRoot, "feature", null)))
					.worktreeEligible,
			).toBe(false);

			await sh(repoRoot, ["checkout", "-q", "feature"]);
			expect(
				(await run(resolveDiffHead(repoRoot, "feature", null)))
					.worktreeEligible,
			).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});

/** Stdout of a real `git` call — test setup only. */
const shOut = async (
	cwd: string,
	args: ReadonlyArray<string>,
): Promise<string> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0)
		throw new Error(`git ${args.join(" ")} failed`);
	return out.trim();
};

const commitFile = async (root: string, name: string) => {
	await Bun.write(join(root, name), `${name}\n`);
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", name]);
	return shOut(root, ["rev-parse", "HEAD"]);
};

describe("resolveDiffHead — PR head known", () => {
	test("a worktree on the PR head, or ahead of it, stays eligible", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "pr"]);
			const prHead = await commitFile(repoRoot, "pr.ts");
			const pullRequest = { number: 1, headSha: prHead, merged: false };
			expect(await run(resolveDiffHead(repoRoot, "pr", pullRequest))).toEqual({
				headRef: undefined,
				worktreeEligible: true,
			});

			await commitFile(repoRoot, "local.ts");
			expect(await run(resolveDiffHead(repoRoot, "pr", pullRequest))).toEqual({
				headRef: undefined,
				worktreeEligible: true,
			});

			// Eligibility follows the commit, not the branch name: a detached
			// HEAD on top of the PR head is the same worktree state.
			await sh(repoRoot, ["checkout", "-q", "--detach"]);
			expect(
				(await run(resolveDiffHead(repoRoot, "pr", pullRequest)))
					.worktreeEligible,
			).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("a merged PR never uses the worktree, even when HEAD is past the PR head", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "pr"]);
			const prHead = await commitFile(repoRoot, "pr.ts");
			await commitFile(repoRoot, "later.ts");

			const pullRequest = { number: 1, headSha: prHead };
			expect(
				await run(
					resolveDiffHead(repoRoot, "pr", { ...pullRequest, merged: false }),
				),
			).toEqual({ headRef: undefined, worktreeEligible: true });
			expect(
				await run(
					resolveDiffHead(repoRoot, "pr", { ...pullRequest, merged: true }),
				),
			).toEqual({ headRef: prHead, worktreeEligible: false });
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("a worktree that moved on to another commit diffs the PR head sha instead", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "pr"]);
			const prHead = await commitFile(repoRoot, "pr.ts");
			await sh(repoRoot, ["checkout", "-q", "-b", "other-task", "main"]);
			await commitFile(repoRoot, "other.ts");
			const refsBefore = await shOut(repoRoot, ["for-each-ref"]);

			expect(
				await run(
					resolveDiffHead(repoRoot, "pr", {
						number: 1,
						headSha: prHead,
						merged: false,
					}),
				),
			).toEqual({ headRef: prHead, worktreeEligible: false });
			expect(await shOut(repoRoot, ["for-each-ref"])).toBe(refsBefore);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("a PR head missing locally is fetched from the main clone, creating no ref", async () => {
		const origin = await makeTestRepo();
		const parent = await mkdtemp(join(tmpdir(), "nisi-diff-head-clone-"));
		const clone = join(parent, "clone");
		const worktree = join(parent, "worktree");
		try {
			await sh(origin, ["checkout", "-q", "-b", "pr"]);
			const prHead = await commitFile(origin, "pr.ts");
			await sh(origin, ["update-ref", "refs/pull/1/head", prHead]);
			await sh(origin, ["checkout", "-q", "main"]);
			await sh(parent, ["clone", "-q", origin, clone]);
			await sh(clone, ["worktree", "add", "-q", "--detach", worktree, "main"]);
			const refsBefore = await shOut(clone, ["for-each-ref"]);

			const result = await run(
				resolveDiffHead(worktree, "pr", {
					number: 1,
					headSha: prHead,
					merged: false,
				}),
			);
			expect(result).toEqual({ headRef: prHead, worktreeEligible: false });
			expect(await shOut(worktree, ["cat-file", "-t", prHead])).toBe("commit");
			expect(await shOut(clone, ["for-each-ref"])).toBe(refsBefore);

			// The cached head was force-pushed away: the PR's current tip wins.
			const stale = "0123456789abcdef0123456789abcdef01234567";
			expect(
				await run(
					resolveDiffHead(worktree, "pr", {
						number: 1,
						headSha: stale,
						merged: false,
					}),
				),
			).toEqual({ headRef: prHead, worktreeEligible: false });
		} finally {
			await rm(origin, { recursive: true, force: true });
			await rm(parent, { recursive: true, force: true });
		}
	});
});

describe("validateHeadRef", () => {
	test("succeeds for a ref that resolves", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await expect(
				run(validateHeadRef(repoRoot, "feature")),
			).resolves.toBeUndefined();
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});

	test("fails with InvalidHeadRef for a ref that doesn't resolve, carrying git's own stderr", async () => {
		const repoRoot = await makeTestRepo();
		try {
			const result = await runResult(
				validateHeadRef(repoRoot, "totally-not-a-real-ref"),
			);
			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure._tag).toBe("InvalidHeadRef");
			if (result.failure._tag !== "InvalidHeadRef") return;
			expect(result.failure.headRef).toBe("totally-not-a-real-ref");
			expect(result.failure.stderr.length).toBeGreaterThan(0);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
