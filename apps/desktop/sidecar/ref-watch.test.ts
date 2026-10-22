import { afterEach, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { watchRefs } from "./ref-watch.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const git = async (cwd: string, args: ReadonlyArray<string>): Promise<void> => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
	}
};

const commit = async (cwd: string, content: string) => {
	await Bun.write(join(cwd, "a.ts"), content);
	await git(cwd, ["commit", "-q", "-am", content]);
};

/** A main clone with a linked worktree, both watched by `watchRefs`. */
async function watchedWorktree() {
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), "nisi-ref-watch-")),
	);
	const repoRoot = join(parent, "repo");
	const worktree = join(parent, "worktree");
	await Bun.$`mkdir ${repoRoot}`.quiet();
	await git(repoRoot, ["init", "-q", "-b", "main"]);
	await git(repoRoot, ["config", "user.email", "test@example.com"]);
	await git(repoRoot, ["config", "user.name", "Test"]);
	await Bun.write(join(repoRoot, "a.ts"), "base\n");
	await git(repoRoot, ["add", "-A"]);
	await git(repoRoot, ["commit", "-q", "-m", "base"]);
	await git(repoRoot, ["worktree", "add", "-q", "-b", "feature", worktree]);

	let changes = 0;
	const watcher = await Effect.runPromise(
		watchRefs(
			worktree,
			() => {
				changes += 1;
			},
			(cause) => {
				throw cause;
			},
		).pipe(Effect.provide(BunServices.layer)),
	);
	if (watcher === undefined) throw new Error("expected a watchable repo");
	cleanups.push(
		() => watcher.close(),
		() => rm(parent, { recursive: true, force: true }),
	);
	return { repoRoot, worktree, watcher, changes: () => changes };
}

/** Waits past the debounce for the count to move; returns how far it moved. */
async function changesAfter(
	read: () => number,
	act: () => Promise<unknown>,
): Promise<number> {
	const before = read();
	await act();
	await Bun.sleep(600);
	return read() - before;
}

test("a commit in the linked worktree reports a change", async () => {
	const repo = await watchedWorktree();
	expect(
		await changesAfter(repo.changes, () => commit(repo.worktree, "v1\n")),
	).toBe(1);
});

test("a commit on another branch of the main clone reports a change", async () => {
	const repo = await watchedWorktree();
	expect(
		await changesAfter(repo.changes, () => commit(repo.repoRoot, "main v1\n")),
	).toBe(1);
});

test("a commit on a branch whose name contains a slash reports a change", async () => {
	const repo = await watchedWorktree();
	await git(repo.worktree, ["checkout", "-q", "-b", "topic/deep/name"]);
	await Bun.sleep(600);
	expect(
		await changesAfter(repo.changes, () => commit(repo.worktree, "v1\n")),
	).toBe(1);
});

test("packing refs reports a change", async () => {
	const repo = await watchedWorktree();
	expect(
		await changesAfter(repo.changes, () =>
			git(repo.repoRoot, ["pack-refs", "--all"]),
		),
	).toBe(1);
});

test("a checkout in the worktree reports a change", async () => {
	const repo = await watchedWorktree();
	await git(repo.worktree, ["branch", "other"]);
	await Bun.sleep(600);
	expect(
		await changesAfter(repo.changes, () =>
			git(repo.worktree, ["checkout", "-q", "other"]),
		),
	).toBe(1);
});

test("index churn and status do not report a change", async () => {
	const repo = await watchedWorktree();
	expect(
		await changesAfter(repo.changes, async () => {
			await git(repo.worktree, ["status"]);
			await Bun.write(join(repo.worktree, "a.ts"), "dirty\n");
			await git(repo.worktree, ["add", "a.ts"]);
			await Bun.write(join(repo.worktree, "new.ts"), "new\n");
			await git(repo.worktree, ["add", "-A"]);
			await git(repo.worktree, ["status"]);
			await git(repo.worktree, ["reset", "-q"]);
		}),
	).toBe(0);
});

test("closing stops events", async () => {
	const repo = await watchedWorktree();
	repo.watcher.close();
	expect(
		await changesAfter(repo.changes, () => commit(repo.worktree, "v1\n")),
	).toBe(0);
});

test("a directory that isn't a git repo can't be watched", async () => {
	const dir = await mkdtemp(join(tmpdir(), "nisi-ref-watch-none-"));
	cleanups.push(() => rm(dir, { recursive: true, force: true }));
	expect(
		await Effect.runPromise(
			watchRefs(
				dir,
				() => {},
				() => {},
			).pipe(Effect.provide(BunServices.layer)),
		),
	).toBeUndefined();
});
