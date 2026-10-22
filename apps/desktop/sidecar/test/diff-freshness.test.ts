import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { GhGitHub } from "@repo/git";
import { ConfigProvider, Effect, Layer } from "effect";
import { subscribe } from "../events.ts";
import { checkSessionForChanges, syncLiveChecks } from "../live-poll.ts";
import { PullRequestAttentionLive } from "../pull-request-attention.ts";
import { SessionWatch } from "../session-watch.ts";
import { Store } from "../store.ts";

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

type Fixture = {
	readonly repoRoot: string;
	readonly worktree: string;
	readonly layer: ReturnType<typeof makeLayer>;
	readonly commit: (cwd: string, content: string) => Promise<void>;
};

const makeLayer = (dataDir: string) =>
	Store.layer.pipe(
		Layer.provideMerge(
			GhGitHub.layer.pipe(Layer.provideMerge(PullRequestAttentionLive.layer)),
		),
		Layer.provideMerge(SessionWatch.layer),
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

/** `main` in the main clone, plus a linked worktree on `feature` whose a.ts is "v1". */
const withFixture = async (fn: (fixture: Fixture) => Promise<void>) => {
	const parent = await realpath(
		await mkdtemp(join(tmpdir(), "nisi-diff-freshness-")),
	);
	const dataDir = join(parent, "data");
	const repoRoot = join(parent, "repo");
	const worktree = join(parent, "worktree");
	try {
		await Bun.$`mkdir ${repoRoot} ${dataDir}`.quiet();
		await git(repoRoot, ["init", "-q", "-b", "main"]);
		await git(repoRoot, ["config", "user.email", "test@example.com"]);
		await git(repoRoot, ["config", "user.name", "Test"]);
		await Bun.write(join(repoRoot, "a.ts"), "base\n");
		await git(repoRoot, ["add", "-A"]);
		await git(repoRoot, ["commit", "-q", "-m", "base"]);
		await git(repoRoot, ["worktree", "add", "-q", "-b", "feature", worktree]);
		const commit = async (cwd: string, content: string) => {
			await Bun.write(join(cwd, "a.ts"), content);
			await git(cwd, ["commit", "-q", "-am", content]);
		};
		await commit(worktree, "v1\n");
		await fn({ repoRoot, worktree, layer: makeLayer(dataDir), commit });
	} finally {
		await rm(parent, { recursive: true, force: true });
	}
};

const waitFor = async (condition: () => boolean, timeoutMs: number) => {
	const deadline = Date.now() + timeoutMs;
	while (!condition() && Date.now() < deadline) await Bun.sleep(25);
};

/** What the `diff.files` handler reports for a session. */
const diffFiles = (sessionId: string) =>
	Effect.gen(function* () {
		const store = yield* Store;
		const files = yield* store.listChangedFiles(sessionId, false);
		return {
			paths: files.map((file) => file.path),
			headAdvanced: yield* store.readHeadAdvanced(sessionId),
		};
	});

const contentsOfA = (sessionId: string) =>
	Effect.gen(function* () {
		const store = yield* Store;
		const contents = yield* store.readFileContents(
			sessionId,
			[{ path: "a.ts", force: false }],
			false,
		);
		return contents[0];
	});

/** What the `sessions.setWatching` handler does on each edge. */
const setWatching = (sessionId: string, watching: boolean) =>
	Effect.gen(function* () {
		const sessionWatch = yield* SessionWatch;
		if (!watching) return yield* sessionWatch.remove(sessionId);
		yield* sessionWatch.add(sessionId);
		yield* checkSessionForChanges(sessionId);
	});

/** Opens a session, reads its diff (which is what pins the head) and baselines live-poll, as the frontend does on first focus. */
const openWatchedSession = (worktree: string) =>
	Effect.gen(function* () {
		const store = yield* Store;
		const outcome = yield* store.openSession(worktree, {
			kind: "branch",
			baseRef: "main",
		});
		yield* diffFiles(outcome.session.id);
		yield* setWatching(outcome.session.id, true);
		return outcome.session;
	});

const sessionTest = (
	name: string,
	body: (
		fixture: Fixture,
		events: string[],
	) => Effect.Effect<void, unknown, Layer.Success<Fixture["layer"]>>,
) =>
	test(name, () =>
		withFixture(async (fixture) => {
			const events: string[] = [];
			const unsubscribe = subscribe((event) => {
				if (event.type === "session-files-changed")
					events.push(event.sessionId);
			});
			try {
				await Effect.runPromise(
					body(fixture, events).pipe(Effect.provide(fixture.layer)),
				);
			} finally {
				unsubscribe();
			}
		}),
	);

sessionTest("opening a session shows the committed head", (fixture, events) =>
	Effect.gen(function* () {
		const session = yield* openWatchedSession(fixture.worktree);

		expect(yield* diffFiles(session.id)).toEqual({
			paths: ["a.ts"],
			headAdvanced: false,
		});
		expect(yield* contentsOfA(session.id)).toMatchObject({
			content: { newContent: "v1\n" },
		});
		expect(events).toEqual([]);
	}),
);

sessionTest(
	"a new commit is announced once but the shown diff stays on the old head",
	(fixture, events) =>
		Effect.gen(function* () {
			const session = yield* openWatchedSession(fixture.worktree);
			yield* Effect.promise(() => fixture.commit(fixture.worktree, "v2\n"));

			yield* checkSessionForChanges(session.id);
			yield* checkSessionForChanges(session.id);
			expect(events).toEqual([session.id]);

			expect(yield* diffFiles(session.id)).toEqual({
				paths: ["a.ts"],
				headAdvanced: true,
			});
			expect(yield* contentsOfA(session.id)).toMatchObject({
				content: { newContent: "v1\n" },
			});
		}),
);

sessionTest(
	"refresh shows the new head and announces nothing further",
	(fixture, events) =>
		Effect.gen(function* () {
			const store = yield* Store;
			const session = yield* openWatchedSession(fixture.worktree);
			yield* Effect.promise(() => fixture.commit(fixture.worktree, "v2\n"));
			yield* checkSessionForChanges(session.id);

			yield* store.refreshSession(session.id);

			expect(yield* diffFiles(session.id)).toEqual({
				paths: ["a.ts"],
				headAdvanced: false,
			});
			expect(yield* contentsOfA(session.id)).toMatchObject({
				content: { newContent: "v2\n" },
			});
			yield* checkSessionForChanges(session.id);
			expect(events).toEqual([session.id]);
		}),
);

sessionTest(
	"index churn, ref packing and commits on other branches announce nothing",
	(fixture, events) =>
		Effect.gen(function* () {
			const session = yield* openWatchedSession(fixture.worktree);

			yield* Effect.promise(async () => {
				await git(fixture.worktree, ["status"]);
				await Bun.write(join(fixture.worktree, "a.ts"), "uncommitted\n");
				await git(fixture.worktree, ["add", "a.ts"]);
				await git(fixture.worktree, ["status"]);
				await git(fixture.repoRoot, ["pack-refs", "--all"]);
				await git(fixture.repoRoot, ["checkout", "-q", "-b", "other"]);
				await fixture.commit(fixture.repoRoot, "other branch\n");
			});
			yield* checkSessionForChanges(session.id);

			expect(events).toEqual([]);
			expect(yield* diffFiles(session.id)).toEqual({
				paths: ["a.ts"],
				headAdvanced: false,
			});
			expect(yield* contentsOfA(session.id)).toMatchObject({
				content: { newContent: "v1\n" },
			});
		}),
);

sessionTest(
	"a commit made while unwatched is announced when watching resumes",
	(fixture, events) =>
		Effect.gen(function* () {
			const session = yield* openWatchedSession(fixture.worktree);
			yield* setWatching(session.id, false);

			yield* Effect.promise(() => fixture.commit(fixture.worktree, "v2\n"));
			expect(events).toEqual([]);

			yield* setWatching(session.id, true);
			expect(events).toEqual([session.id]);
			expect(yield* diffFiles(session.id)).toEqual({
				paths: ["a.ts"],
				headAdvanced: true,
			});
			expect(yield* contentsOfA(session.id)).toMatchObject({
				content: { newContent: "v1\n" },
			});
		}),
);

sessionTest(
	"the live check announces a commit once, from the ref watcher, and ignores index churn",
	(fixture, events) =>
		Effect.gen(function* () {
			const sessionWatch = yield* SessionWatch;
			const session = yield* openWatchedSession(fixture.worktree);
			yield* syncLiveChecks();

			try {
				yield* Effect.promise(() => fixture.commit(fixture.worktree, "v2\n"));
				// Under POLL_INTERVAL, so only the watcher can have noticed it.
				yield* Effect.promise(() => waitFor(() => events.length > 0, 1000));
				yield* Effect.promise(() => Bun.sleep(500));
				expect(events).toEqual([session.id]);

				yield* Effect.promise(async () => {
					await Bun.write(join(fixture.worktree, "a.ts"), "uncommitted\n");
					await git(fixture.worktree, ["add", "a.ts"]);
					await git(fixture.worktree, ["status"]);
					await Bun.sleep(500);
				});
				expect(events).toEqual([session.id]);
			} finally {
				yield* sessionWatch.remove(session.id);
				yield* syncLiveChecks();
			}
		}),
);
