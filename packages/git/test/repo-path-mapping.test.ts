import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import {
	guessSiblingRepoPath,
	inferRepoPath,
	type KnownRepoPath,
	parseOwnerRepoFromRemoteUrl,
	verifyRepoPathMatchesOrigin,
} from "../src/repo-path-mapping.ts";

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

/** A real git repo at an exact path (not a random temp dir), with `origin` set to `remoteUrl` — needed so a guessed sibling path lands exactly where `guessSiblingRepoPath` computes it. */
const makeRepoAt = async (path: string, remoteUrl?: string): Promise<void> => {
	await mkdir(path, { recursive: true });
	await sh(path, ["init", "-q", "-b", "main"]);
	if (remoteUrl !== undefined) {
		await sh(path, ["remote", "add", "origin", remoteUrl]);
	}
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("parseOwnerRepoFromRemoteUrl", () => {
	test("HTTPS with .git suffix", () => {
		expect(
			parseOwnerRepoFromRemoteUrl("https://github.com/fdarian/nisi.git"),
		).toEqual({ owner: "fdarian", repo: "nisi" });
	});

	test("HTTPS without .git suffix", () => {
		expect(
			parseOwnerRepoFromRemoteUrl("https://github.com/fdarian/nisi"),
		).toEqual({ owner: "fdarian", repo: "nisi" });
	});

	test("SSH scp-style", () => {
		expect(
			parseOwnerRepoFromRemoteUrl("git@github.com:fdarian/nisi.git"),
		).toEqual({ owner: "fdarian", repo: "nisi" });
	});

	test("SSH URL form, non-github host", () => {
		expect(
			parseOwnerRepoFromRemoteUrl(
				"ssh://git@github.enterprise.corp/fdarian/nisi.git",
			),
		).toEqual({ owner: "fdarian", repo: "nisi" });
	});

	test("not a recognizable owner/repo URL", () => {
		expect(parseOwnerRepoFromRemoteUrl("not-a-url")).toBeNull();
	});
});

describe("guessSiblingRepoPath", () => {
	const known: ReadonlyArray<KnownRepoPath> = [
		{ owner: "fdarian", repo: "nisi", path: "/Users/x/code/fdarian/nisi" },
	];

	test("swaps the last path segment for the new repo, same owner", () => {
		expect(guessSiblingRepoPath(known, "fdarian", "whap")).toBe(
			"/Users/x/code/fdarian/whap",
		);
	});

	test("owner comparison is case-insensitive", () => {
		expect(guessSiblingRepoPath(known, "Fdarian", "whap")).toBe(
			"/Users/x/code/fdarian/whap",
		);
	});

	test("null when no known mapping shares the owner", () => {
		expect(guessSiblingRepoPath(known, "someoneelse", "whap")).toBeNull();
	});

	test("null with no known mappings at all", () => {
		expect(guessSiblingRepoPath([], "fdarian", "whap")).toBeNull();
	});
});

describe("verifyRepoPathMatchesOrigin", () => {
	test("matches when origin resolves to the expected owner/repo, returning the canonical repo root", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const path = join(parent, "nisi");
			await makeRepoAt(path, "https://github.com/fdarian/nisi.git");
			await expect(
				run(verifyRepoPathMatchesOrigin(path, "fdarian", "nisi")),
			).resolves.toBe(await realpath(path));
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("a subdirectory of the clone normalizes to the repository root", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const path = join(parent, "nisi");
			await makeRepoAt(path, "https://github.com/fdarian/nisi.git");
			const subdir = join(path, "apps", "web");
			await mkdir(subdir, { recursive: true });

			const result = await run(
				verifyRepoPathMatchesOrigin(subdir, "fdarian", "nisi"),
			);
			expect(result).toBe(await realpath(path));
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("a worktree normalizes to the main clone root, not the worktree's own root", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const mainPath = join(parent, "nisi");
			await makeRepoAt(mainPath, "https://github.com/fdarian/nisi.git");
			// A worktree needs at least one commit to branch off of.
			await sh(mainPath, ["commit", "--allow-empty", "-q", "-m", "init"]);
			const worktreePath = join(parent, "nisi-worktree");
			await sh(mainPath, [
				"worktree",
				"add",
				"-q",
				"-b",
				"some-branch",
				worktreePath,
			]);

			const result = await run(
				verifyRepoPathMatchesOrigin(worktreePath, "fdarian", "nisi"),
			);
			expect(result).toBe(await realpath(mainPath));
			expect(result).not.toBe(await realpath(worktreePath));
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("a symlinked path prefix canonicalizes to the real path", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const realParent = join(parent, "real");
			await mkdir(realParent, { recursive: true });
			const path = join(realParent, "nisi");
			await makeRepoAt(path, "https://github.com/fdarian/nisi.git");

			const symlinkedParent = join(parent, "linked");
			await symlink(realParent, symlinkedParent);
			const symlinkedPath = join(symlinkedParent, "nisi");

			const result = await run(
				verifyRepoPathMatchesOrigin(symlinkedPath, "fdarian", "nisi"),
			);
			expect(result).toBe(await realpath(path));
			expect(result).not.toBe(symlinkedPath);
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("fails with RepoPathOriginMismatch when origin points elsewhere", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const path = join(parent, "nisi");
			await makeRepoAt(path, "https://github.com/someoneelse/nisi.git");
			const error = await run(
				verifyRepoPathMatchesOrigin(path, "fdarian", "nisi").pipe(Effect.flip),
			);
			expect(error._tag).toBe("RepoPathOriginMismatch");
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("fails with RepoPathNoOriginRemote when the repo has no origin", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const path = join(parent, "nisi");
			await makeRepoAt(path);
			const error = await run(
				verifyRepoPathMatchesOrigin(path, "fdarian", "nisi").pipe(Effect.flip),
			);
			expect(error._tag).toBe("RepoPathNoOriginRemote");
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("fails with RepoPathNotAGitRepo when the path exists but isn't a repo", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const path = join(parent, "not-a-repo");
			await mkdir(path, { recursive: true });
			const error = await run(
				verifyRepoPathMatchesOrigin(path, "fdarian", "nisi").pipe(Effect.flip),
			);
			expect(error._tag).toBe("RepoPathNotAGitRepo");
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("fails with RepoPathNotFound when the path doesn't exist", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const error = await run(
				verifyRepoPathMatchesOrigin(
					join(parent, "ghost"),
					"fdarian",
					"nisi",
				).pipe(Effect.flip),
			);
			expect(error._tag).toBe("RepoPathNotFound");
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});
});

describe("inferRepoPath", () => {
	test("verified sibling guess: path exists and its origin matches the expected repo, normalized like a picked path would be", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const nisiPath = join(parent, "fdarian", "nisi");
			const whapPath = join(parent, "fdarian", "whap");
			await makeRepoAt(nisiPath, "https://github.com/fdarian/nisi.git");
			await makeRepoAt(whapPath, "https://github.com/fdarian/whap.git");

			const known: ReadonlyArray<KnownRepoPath> = [
				{ owner: "fdarian", repo: "nisi", path: nisiPath },
			];
			const result = await run(inferRepoPath(known, "fdarian", "whap"));
			expect(result).toBe(await realpath(whapPath));
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("guessed path exists but its origin doesn't match — never used, falls through to null", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const nisiPath = join(parent, "fdarian", "nisi");
			const whapPath = join(parent, "fdarian", "whap");
			await makeRepoAt(nisiPath, "https://github.com/fdarian/nisi.git");
			// Same directory name nisi would guess, but it's actually a clone of
			// someone else's repo — the guess must not be trusted.
			await makeRepoAt(whapPath, "https://github.com/someoneelse/whap.git");

			const known: ReadonlyArray<KnownRepoPath> = [
				{ owner: "fdarian", repo: "nisi", path: nisiPath },
			];
			const result = await run(inferRepoPath(known, "fdarian", "whap"));
			expect(result).toBeNull();
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("guessed path doesn't exist on disk at all — falls through to null", async () => {
		const parent = await mkdtemp(join(tmpdir(), "nisi-repo-mapping-"));
		try {
			const nisiPath = join(parent, "fdarian", "nisi");
			await makeRepoAt(nisiPath, "https://github.com/fdarian/nisi.git");
			// No "whap" directory is ever created next to it.

			const known: ReadonlyArray<KnownRepoPath> = [
				{ owner: "fdarian", repo: "nisi", path: nisiPath },
			];
			const result = await run(inferRepoPath(known, "fdarian", "whap"));
			expect(result).toBeNull();
		} finally {
			await rm(parent, { recursive: true, force: true });
		}
	});

	test("null when no known mapping shares the owner — nothing to guess from", async () => {
		const result = await run(
			inferRepoPath(
				[{ owner: "someoneelse", repo: "x", path: "/tmp/someoneelse/x" }],
				"fdarian",
				"whap",
			),
		);
		expect(result).toBeNull();
	});
});
