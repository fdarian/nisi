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

const runResult = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(
		Effect.result(effect.pipe(Effect.provide(BunServices.layer))),
	);

describe("resolveDiffHead", () => {
	test("a PR-backed session is always worktree-eligible, regardless of what's checked out", async () => {
		const repoRoot = await makeTestRepo();
		try {
			await sh(repoRoot, ["checkout", "-q", "-b", "some-other-branch"]);

			const result = await run(
				resolveDiffHead(repoRoot, "feature-from-a-fork", true),
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

			const result = await run(resolveDiffHead(repoRoot, "feature", false));
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

			const result = await run(resolveDiffHead(repoRoot, "feature-a", false));
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

			const result = await run(resolveDiffHead(repoRoot, "feature", false));
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
				(await run(resolveDiffHead(repoRoot, "feature", false)))
					.worktreeEligible,
			).toBe(false);

			await sh(repoRoot, ["checkout", "-q", "feature"]);
			expect(
				(await run(resolveDiffHead(repoRoot, "feature", false)))
					.worktreeEligible,
			).toBe(true);
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
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
