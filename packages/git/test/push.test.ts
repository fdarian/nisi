import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import { type PushEvent, pushBranch } from "../src/push.ts";
import { resolveUnpushedCommits } from "../src/repo.ts";
import { cleanupTestRepo, makeTestRepo, type TestRepo } from "./fixtures.ts";

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

const collect = (repoRoot: string, rebase: boolean, headRef = "main") =>
	run(
		Stream.runCollect(
			pushBranch(repoRoot, { rebase, pullRequest: { number: 1, headRef } }),
		),
	);

const lastEvent = (events: ReadonlyArray<PushEvent>) => events.at(-1);

type Fixture = {
	readonly repo: TestRepo;
	readonly bareDir: string;
	/** Commits straight to origin from a second clone, as another contributor would. */
	readonly pushFromElsewhere: (
		path: string,
		content: string,
		message: string,
	) => Promise<void>;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sh = async (cwd: string, args: ReadonlyArray<string>) => {
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
	if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
	return stdout;
};

/** Points `refs/pull/1/head` at `branch`'s tip, which is how GitHub keeps a same-repo PR's head ref in sync. */
const publishPullRequestHead = (bareDir: string, branch: string) =>
	sh(bareDir, ["update-ref", "refs/pull/1/head", `refs/heads/${branch}`]);

/** A `feature` branch checked out locally at `origin/main`, tracking it, with a local commit on top. */
const checkoutFeatureWithLocalCommit = async (fixture: Fixture) => {
	await fixture.repo.git([
		"checkout",
		"-q",
		"-b",
		"feature",
		"--track",
		"origin/main",
	]);
	await fixture.repo.write("b.ts", "local\n");
	await fixture.repo.commit("local");
};

const makeFixture = async (): Promise<Fixture> => {
	const bareDir = await mkdtemp(join(tmpdir(), "nisi-push-origin-"));
	await sh(bareDir, ["init", "-q", "--bare", "-b", "main"]);

	const repo = await makeTestRepo();
	await repo.git(["remote", "add", "origin", bareDir]);
	await repo.write("a.ts", "line 1\nline 2\nline 3\n");
	await repo.commit("base");
	await repo.git(["push", "-q", "origin", "main"]);
	await publishPullRequestHead(bareDir, "main");

	const otherDir = await mkdtemp(join(tmpdir(), "nisi-push-other-"));
	await sh(otherDir, ["clone", "-q", bareDir, "clone"]);
	const otherRoot = join(otherDir, "clone");
	await sh(otherRoot, ["config", "user.email", "other@example.com"]);
	await sh(otherRoot, ["config", "user.name", "Other"]);

	cleanups.push(async () => {
		await cleanupTestRepo(repo);
		await rm(bareDir, { recursive: true, force: true });
		await rm(otherDir, { recursive: true, force: true });
	});

	return {
		repo,
		bareDir,
		pushFromElsewhere: async (path, content, message) => {
			await Bun.write(join(otherRoot, path), content);
			await sh(otherRoot, ["add", "-A"]);
			await sh(otherRoot, ["commit", "-q", "-m", message]);
			await sh(otherRoot, ["push", "-q", "origin", "main"]);
			await publishPullRequestHead(bareDir, "main");
		},
	};
};

/** `resolveUnpushedCommits` against the PR head GitHub would publish for `headRef`'s branch on origin. */
const unpushedAfter = async (fixture: Fixture, headRef: string) => {
	await sh(fixture.bareDir, [
		"update-ref",
		"refs/pull/1/head",
		`refs/heads/${headRef}`,
	]);
	return run(
		resolveUnpushedCommits(fixture.repo.root, null, { number: 1, headRef }),
	);
};

const exists = (path: string) =>
	stat(path).then(
		() => true,
		() => false,
	);

describe("pushBranch", () => {
	test("pushes local commits and ends with done", async () => {
		const fixture = await makeFixture();
		await fixture.repo.write("b.ts", "local\n");
		await fixture.repo.commit("local");

		const events = await collect(fixture.repo.root, false);

		expect(events[0]).toEqual({
			type: "step",
			command: "git push --progress origin HEAD:main",
		});
		expect(lastEvent(events)).toEqual({ type: "done" });
		expect(events.some((event) => event.type === "line")).toBe(true);

		const after = await unpushedAfter(fixture, "main");
		expect(after.ahead).toBe(0);
	});

	test("pushes to the PR's head branch, ignoring an upstream of origin/main", async () => {
		const fixture = await makeFixture();
		await checkoutFeatureWithLocalCommit(fixture);
		await sh(fixture.bareDir, [
			"update-ref",
			"refs/heads/feature",
			"refs/heads/main",
		]);
		await publishPullRequestHead(fixture.bareDir, "feature");
		const mainBefore = (
			await sh(fixture.bareDir, ["rev-parse", "main"])
		).trim();

		const events = await collect(fixture.repo.root, false, "feature");

		expect(events[0]).toEqual({
			type: "step",
			command: "git push --progress origin HEAD:feature",
		});
		expect(lastEvent(events)).toEqual({ type: "done" });
		const remoteHead = await sh(fixture.bareDir, ["rev-parse", "feature"]);
		expect(remoteHead.trim()).toBe(
			(await fixture.repo.git(["rev-parse", "HEAD"])).trim(),
		);
		expect((await sh(fixture.bareDir, ["rev-parse", "main"])).trim()).toBe(
			mainBefore,
		);
		expect((await unpushedAfter(fixture, "feature")).ahead).toBe(0);
	});

	test("rebases onto the PR's head branch, not the upstream", async () => {
		const fixture = await makeFixture();
		await checkoutFeatureWithLocalCommit(fixture);
		await sh(fixture.bareDir, [
			"update-ref",
			"refs/heads/feature",
			"refs/heads/main",
		]);
		await publishPullRequestHead(fixture.bareDir, "feature");

		const events = await collect(fixture.repo.root, true, "feature");

		expect(events[0]).toEqual({
			type: "step",
			command: "git pull --rebase --autostash origin feature",
		});
	});

	test("refuses a fork PR whose branch isn't on origin, leaving origin untouched", async () => {
		const fixture = await makeFixture();
		await checkoutFeatureWithLocalCommit(fixture);
		const refsBefore = await sh(fixture.bareDir, ["for-each-ref"]);

		const events = await collect(fixture.repo.root, false, "feature");

		expect(events).toHaveLength(1);
		const only = events[0];
		expect(only?.type === "failed" && only.reason).toBe("other");
		expect(only?.type === "failed" && only.message).toContain(
			"isn't on origin",
		);
		expect(await sh(fixture.bareDir, ["for-each-ref"])).toBe(refsBefore);
	});

	test("refuses when origin's branch isn't at the PR's head", async () => {
		const fixture = await makeFixture();
		await checkoutFeatureWithLocalCommit(fixture);
		await sh(fixture.bareDir, [
			"update-ref",
			"refs/heads/feature",
			"refs/heads/main",
		]);
		const sameNamedOtherBranch = (
			await sh(fixture.repo.root, ["rev-parse", "HEAD"])
		).trim();
		await sh(fixture.repo.root, [
			"push",
			"-q",
			"origin",
			"HEAD:refs/heads/unrelated",
		]);
		await sh(fixture.bareDir, [
			"update-ref",
			"refs/pull/1/head",
			sameNamedOtherBranch,
		]);
		const refsBefore = await sh(fixture.bareDir, ["for-each-ref"]);

		const events = await collect(fixture.repo.root, false, "feature");

		expect(events).toHaveLength(1);
		const only = events[0];
		expect(only?.type === "failed" && only.reason).toBe("other");
		expect(only?.type === "failed" && only.message).toContain(
			"isn't on origin",
		);
		expect(await sh(fixture.bareDir, ["for-each-ref"])).toBe(refsBefore);
	});

	test("refuses to push a branch other than the PR's", async () => {
		const fixture = await makeFixture();
		await fixture.repo.git(["checkout", "-q", "-b", "unrelated"]);

		const events = await collect(fixture.repo.root, false, "feature");

		expect(events).toHaveLength(1);
		const only = events[0];
		expect(only?.type === "failed" && only.reason).toBe("other");
	});

	test("reports rejected when the remote has moved ahead", async () => {
		const fixture = await makeFixture();
		await fixture.pushFromElsewhere("c.ts", "remote\n", "remote moved");
		await fixture.repo.write("b.ts", "local\n");
		await fixture.repo.commit("local");

		const events = await collect(fixture.repo.root, false);

		const last = lastEvent(events);
		expect(last?.type).toBe("failed");
		expect(last?.type === "failed" && last.reason).toBe("rejected");
	});

	test("rebases onto the remote and then pushes", async () => {
		const fixture = await makeFixture();
		await fixture.pushFromElsewhere("c.ts", "remote\n", "remote moved");
		await fixture.repo.write("b.ts", "local\n");
		await fixture.repo.commit("local");

		const events = await collect(fixture.repo.root, true);

		expect(
			events.filter((event) => event.type === "step").map((e) => e.command),
		).toEqual([
			"git pull --rebase --autostash origin main",
			"git push --progress origin HEAD:main",
		]);
		expect(lastEvent(events)).toEqual({ type: "done" });
		const after = await unpushedAfter(fixture, "main");
		expect(after.ahead).toBe(0);
		expect(after.behind).toBe(0);
		expect(await exists(join(fixture.repo.root, "c.ts"))).toBe(true);
	});

	test("rebases a dirty worktree via autostash and restores the changes", async () => {
		const fixture = await makeFixture();
		await fixture.pushFromElsewhere("c.ts", "remote\n", "remote moved");
		await fixture.repo.write("b.ts", "local\n");
		await fixture.repo.commit("local");
		await fixture.repo.write("a.ts", "line 1\nline 2\nline 3\nuncommitted\n");

		const events = await collect(fixture.repo.root, true);

		expect(lastEvent(events)).toEqual({ type: "done" });
		expect(await Bun.file(join(fixture.repo.root, "a.ts")).text()).toBe(
			"line 1\nline 2\nline 3\nuncommitted\n",
		);
	});

	test("aborts a conflicting rebase and leaves the worktree as it was", async () => {
		const fixture = await makeFixture();
		await fixture.pushFromElsewhere(
			"a.ts",
			"remote 1\nline 2\nline 3\n",
			"remote edit",
		);
		await fixture.repo.write("a.ts", "local 1\nline 2\nline 3\n");
		const localHead = await fixture.repo.commit("local edit");

		const events = await collect(fixture.repo.root, true);

		const last = lastEvent(events);
		expect(last?.type).toBe("failed");
		expect(last?.type === "failed" && last.reason).toBe("rebase-conflict");
		expect(
			events.filter((event) => event.type === "step").map((e) => e.command),
		).toEqual([
			"git pull --rebase --autostash origin main",
			"git rebase --abort",
		]);

		expect((await fixture.repo.git(["status", "--porcelain"])).trim()).toBe("");
		const gitDir = (
			await fixture.repo.git(["rev-parse", "--absolute-git-dir"])
		).trim();
		expect(await exists(join(gitDir, "rebase-merge"))).toBe(false);
		expect(await exists(join(gitDir, "rebase-apply"))).toBe(false);
		expect((await fixture.repo.git(["rev-parse", "HEAD"])).trim()).toBe(
			localHead,
		);
		expect((await fixture.repo.git(["branch", "--show-current"])).trim()).toBe(
			"main",
		);
	});

	test("fails with other when HEAD is detached", async () => {
		const fixture = await makeFixture();
		await fixture.repo.git(["checkout", "-q", "--detach"]);

		const events = await collect(fixture.repo.root, false);

		expect(events).toHaveLength(1);
		const only = events[0];
		expect(only?.type === "failed" && only.reason).toBe("other");
	});
});
