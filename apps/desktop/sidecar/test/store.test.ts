import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import {
	GhGitHub,
	GitHub,
	type GitHubShape,
	PullRequestNotFound,
} from "@repo/git";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
import {
	ConfigProvider,
	type Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Option,
	Result,
	Stream,
} from "effect";
import { subscribe } from "../events.ts";
import { PrIndex } from "../pr-index.ts";
import { PullRequestAttentionLive } from "../pull-request-attention.ts";
import { type OpenSessionOutcome, Store } from "../store.ts";
import { gatherGenerationContext } from "../walkthrough/context.ts";

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

/** A throwaway repo with one commit on `main` — enough for `resolveMergeBase`/`resolveCurrentBranch` to have something real to resolve against. */
const makeTestRepo = async (): Promise<string> => {
	const root = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-repo-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);
	await Bun.write(join(root, "a.ts"), "hello\n");
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", "base"]);
	return root;
};

/** Same composition as `packages/review/test/fixtures.ts`'s `makeTestLayer`, one layer up — `Store.layer` already pulls in `ReviewStore.layer` via `provideMerge`, so this only has to add what `Store.make` needs beyond that: `SqliteDb` and `NISI_DATA_DIR`. */
const mockGitHub: GitHubShape = {
	listOpenPullRequests: () =>
		Effect.succeed({
			repository: { owner: "acme", repo: "widgets", defaultBranch: "main" },
			prs: [],
		}),
	getActionsJob: () => Effect.die(new Error("unused mock GitHub method")),
	getActionsJobLogs: () => Effect.die(new Error("unused mock GitHub method")),
	rerunActionsJob: () => Effect.die(new Error("unused mock GitHub method")),
	repository: () =>
		Effect.succeed({ owner: "acme", repo: "widgets", defaultBranch: "main" }),
	pullRequest: () =>
		Effect.succeed({
			number: 42,
			title: "Add widgets",
			baseRef: "main",
			headRef: "main",
			isCrossRepository: false,
		}),
	pullRequestState: () => Effect.die(new Error("unused mock GitHub method")),
	headRef: () => Effect.succeed("main"),
	search: () => Effect.die(new Error("unused mock GitHub method")),
	checks: () => Effect.die(new Error("unused mock GitHub method")),
	checksSnapshot: () => Effect.die(new Error("unused mock GitHub method")),
	approveWorkflowRuns: () => Effect.die(new Error("unused mock GitHub method")),
	overview: () => Effect.die(new Error("unused mock GitHub method")),
	stack: () => Effect.die(new Error("unused mock GitHub method")),
	mergeability: () => Effect.die(new Error("unused mock GitHub method")),
	mergeMethods: () => Effect.die(new Error("unused mock GitHub method")),
	merge: () => Effect.die(new Error("unused mock GitHub method")),
	mergeStack: () => Effect.die(new Error("unused mock GitHub method")),
	markReady: () => Effect.die(new Error("unused mock GitHub method")),
	watchChecks: () => Stream.die(new Error("unused mock GitHub method")),
	watchMergeStatus: () => Stream.die(new Error("unused mock GitHub method")),
	watchStack: () => Stream.die(new Error("unused mock GitHub method")),
	watchOverview: () => Stream.die(new Error("unused mock GitHub method")),
};

const makeTestLayer = (
	dataDir: string,
	withPullRequest: boolean | GitHubShape = false,
	index?: Context.Service.Shape<typeof PrIndex>,
) =>
	(index === undefined
		? Store.layer
		: Layer.effect(Store, Store.make).pipe(
				Layer.provideMerge(ReviewStore.layer),
				Layer.provideMerge(SettingsStore.layer),
				Layer.provideMerge(Layer.succeed(PrIndex, index)),
			)
	).pipe(
		Layer.provideMerge(
			withPullRequest
				? Layer.succeed(
						GitHub,
						typeof withPullRequest === "boolean" ? mockGitHub : withPullRequest,
					)
				: GhGitHub.layer.pipe(
						Layer.provideMerge(PullRequestAttentionLive.layer),
					),
		),
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

const openedSession = <E, R>(effect: Effect.Effect<OpenSessionOutcome, E, R>) =>
	effect.pipe(Effect.map((outcome) => outcome.session));

const withTestRepoAndDataDir = async <T>(
	fn: (repoRoot: string, dataDir: string) => Promise<T>,
): Promise<T> => {
	const repoRoot = await makeTestRepo();
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-data-"));
	try {
		return await fn(repoRoot, dataDir);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	}
};

test("recording a repository path starts a non-blocking index refresh for deep links", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		await sh(repoRoot, [
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widgets.git",
		]);
		const started = await Effect.runPromise(Deferred.make<void>());
		const finish = await Effect.runPromise(Deferred.make<void>());
		const canonicalRoot = await realpath(repoRoot);
		const github: GitHubShape = {
			...mockGitHub,
			listOpenPullRequests: (path, owner, repo) =>
				Effect.gen(function* () {
					expect(path).toBe(canonicalRoot);
					expect(`${owner}/${repo}`).toBe("acme/widgets");
					yield* Deferred.succeed(started, undefined);
					yield* Deferred.await(finish);
					return {
						repository: { owner, repo, defaultBranch: "main" },
						prs: [],
					};
				}),
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				expect(
					(yield* store.recordRepoPath("acme", "widgets", repoRoot)).path,
				).toBe(canonicalRoot);
				yield* Deferred.await(started);
				yield* Deferred.succeed(finish, undefined);
			}).pipe(Effect.provide(makeTestLayer(dataDir, github))),
		);
	});
});

test("index disagreement upserts the correct PR's existing row without transferring snapshots; no-PR correction uses a branch key", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		await sh(repoRoot, ["remote", "add", "origin", repoRoot]);
		const canonicalRoot = await realpath(repoRoot);
		const state = { number: 43, noPr: false };
		const index: Context.Service.Shape<typeof PrIndex> = {
			lookupPullRequest: () => Effect.succeed(undefined),
			lookup: () =>
				Effect.succeed({
					repository: { owner: "acme", repo: "widgets", defaultBranch: "main" },
					pr: {
						number: 42,
						title: "Old PR",
						baseRef: "main",
						headRef: "main",
						isCrossRepository: false,
						headOwner: "acme",
					},
				}),
			refresh: () => Effect.succeed(undefined),
			refreshKnown: Effect.void,
			start: Effect.never,
		};
		const github: GitHubShape = {
			...mockGitHub,
			pullRequest: () =>
				Effect.succeed(
					state.noPr
						? null
						: {
								number: state.number,
								title: "Current PR",
								baseRef: "main",
								headRef: "main",
								isCrossRepository: false,
							},
				),
		};
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				const reviews = yield* ReviewStore;
				const correct = yield* reviews.openSession({
					repoRoot: canonicalRoot,
					baseRef: "main",
					headRef: "main",
					pr: {
						number: 43,
						title: "Current PR",
						owner: "acme",
						repo: "widgets",
					},
				});
				yield* reviews.markFileViewed(
					correct.id,
					"a.ts",
					Option.some(new TextEncoder().encode("PR43 snapshot")),
				);
				yield* reviews.closeSession(correct.id);
				const provisional = (yield* store.openSession(repoRoot)).session;
				yield* reviews.markFileViewed(
					provisional.id,
					"a.ts",
					Option.some(new TextEncoder().encode("PR42 snapshot")),
				);
				const original = yield* reviews.getFileReviewState(
					provisional.id,
					"a.ts",
				);
				const correction = yield* Deferred.make<OpenSessionOutcome>();
				const branchSource = yield* reviews.openSession({
					repoRoot: canonicalRoot,
					baseRef: "main",
					headRef: "main",
					pr: null,
				});
				yield* store.forkRevalidation(provisional, (outcome) =>
					Deferred.succeed(correction, outcome).pipe(Effect.asVoid),
				);
				const corrected = yield* Deferred.await(correction);
				expect(corrected.session.target).toMatchObject({
					kind: "pr",
					number: 43,
				});
				expect(corrected.session.id).toBe(correct.id);
				expect(corrected.transitions).toMatchObject([
					{ kind: "existing", sourceSessionId: branchSource.id },
				]);
				expect(
					yield* reviews.getFileReviewState(provisional.id, "a.ts"),
				).toEqual(original);
				expect(
					(yield* reviews.getFileReviewState(correct.id, "a.ts"))?.snapshotHash,
				).not.toBe(original?.snapshotHash);
				state.noPr = true;
				const next = (yield* store.openSession(repoRoot)).session;
				const branchCorrection = yield* Deferred.make<OpenSessionOutcome>();
				yield* store.forkRevalidation(next, (outcome) =>
					Deferred.succeed(branchCorrection, outcome).pipe(Effect.asVoid),
				);
				const branch = yield* Deferred.await(branchCorrection);
				expect(branch.session.target.kind).toBe("branch");
				expect(branch.session.id).not.toBe(next.id);
				expect(yield* reviews.getFileReviewState(next.id, "a.ts")).toEqual(
					original,
				);
				const required = (yield* store.openSession(repoRoot, { kind: "pr" }))
					.session;
				const requiredValidation = yield* store.forkRevalidation(required, () =>
					Effect.die("an explicit PR open must never downgrade to a branch"),
				);
				yield* Fiber.join(requiredValidation);
				expect(
					(yield* store.listSessions()).find(
						(session) => session.id === required.id,
					)?.target.kind,
				).toBe("pr");
				state.noPr = false;
				state.number = 44;
				const retargeted = yield* Deferred.make<OpenSessionOutcome>();
				const pending = (yield* store.openSession(repoRoot)).session;
				const anotherBranch = yield* reviews.openSession({
					repoRoot: canonicalRoot,
					baseRef: "main",
					headRef: "main",
					pr: null,
				});
				const retargetValidation = yield* store.forkRevalidation(
					pending,
					(outcome) =>
						Deferred.succeed(retargeted, outcome).pipe(Effect.asVoid),
				);
				yield* Fiber.join(retargetValidation);
				expect((yield* Deferred.await(retargeted)).transitions).toMatchObject([
					{ kind: "retargeted", sourceSessionId: anotherBranch.id },
				]);
			}).pipe(
				Effect.provide(makeTestLayer(dataDir, github, index)),
				Effect.scoped,
			),
		);
	});
});

test("base refresh drops upstream-only files without changing head or remaining reviewed state; offline refresh warns", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		const upstream = await makeTestRepo();
		try {
			await sh(upstream, ["fetch", repoRoot, "main"]);
			await sh(upstream, ["reset", "--hard", "FETCH_HEAD"]);
			await sh(repoRoot, ["remote", "add", "origin", upstream]);
			await sh(repoRoot, ["checkout", "-b", "feature"]);
			await Bun.write(join(repoRoot, "merged.ts"), "upstream changeset\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-m", "merged changeset"]);
			await sh(repoRoot, ["branch", "upstream-change"]);
			await Bun.write(join(repoRoot, "a.ts"), "reviewed PR change\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-m", "PR change"]);
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* openedSession(
						store.openSession(repoRoot, { kind: "branch", baseRef: "main" }),
					);
					const other = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "origin/main",
						}),
					);
					const movedSessions: string[] = [];
					const staleSessions: string[] = [];
					const unsubscribe = subscribe((event) => {
						if (event.type === "session-files-changed")
							movedSessions.push(event.sessionId);
						if (event.type === "session-base-staleness-changed")
							staleSessions.push(event.sessionId);
					});
					yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
					expect(
						(yield* store.listChangedFiles(session.id, false)).map(
							(file) => file.path,
						),
					).toEqual(["a.ts", "merged.ts"]);
					yield* store.setFileViewed(session.id, "a.ts", true);
					const reviewed = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					yield* Effect.promise(async () => {
						await sh(upstream, ["fetch", repoRoot, "upstream-change"]);
						await sh(upstream, ["reset", "--hard", "FETCH_HEAD"]);
					});
					// Explicit refresh intentionally reuses a successful fetch for five seconds.
					yield* Effect.sleep("5 seconds");
					expect(
						(yield* store.refreshSessionBase(session.id)).baseMayBeStale,
					).toBe(false);
					expect(movedSessions).toContain(session.id);
					expect(movedSessions).toContain(other.id);
					expect(staleSessions).toEqual([]);
					const remaining = yield* store.listChangedFiles(session.id, false);
					expect(remaining.map((file) => file.path)).toEqual(["a.ts"]);
					expect(remaining[0]?.review?.viewed).toBe(true);
					expect(remaining[0]?.review?.changedSinceReview).toBe(false);
					expect(
						yield* reviewStore.getFileReviewState(session.id, "a.ts"),
					).toEqual(reviewed);
					yield* Effect.promise(() =>
						sh(repoRoot, [
							"remote",
							"set-url",
							"origin",
							`${upstream}/missing`,
						]),
					);
					yield* Effect.sleep("5 seconds");
					expect(
						(yield* store.refreshSessionBase(session.id)).baseMayBeStale,
					).toBe(true);
					expect(yield* store.readBaseMayBeStale(session.id)).toBe(true);
					expect(staleSessions).toContain(session.id);
					expect(staleSessions).toContain(other.id);
					staleSessions.length = 0;
					expect(
						(yield* store.listChangedFiles(session.id, false)).map(
							(file) => file.path,
						),
					).toEqual(["a.ts"]);
					yield* Effect.promise(() =>
						sh(repoRoot, ["remote", "set-url", "origin", upstream]),
					);
					expect(
						(yield* store.refreshSessionBase(session.id)).baseMayBeStale,
					).toBe(false);
					expect(yield* store.readBaseMayBeStale(session.id)).toBe(false);
					expect(staleSessions).toContain(session.id);
				}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
			);
		} finally {
			await rm(upstream, { recursive: true, force: true });
		}
	});
}, 20_000);

describe("Store.listSessions — a session whose directory was deleted", () => {
	test("still lists every session instead of failing the whole call", async () => {
		await withTestRepoAndDataDir(async (aliveRoot, dataDir) => {
			const deadRoot = await makeTestRepo();
			try {
				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						// Straight into the review store: `Store.openSession` prepares the
						// base, and `listSessions` skips sessions prepared in the last 5s.
						const open = (repoRoot: string) =>
							reviews.openSession({
								repoRoot,
								baseRef: "main",
								headRef: "main",
								pr: null,
							});
						const alive = yield* open(aliveRoot);
						const dead = yield* open(deadRoot);
						yield* Effect.promise(() =>
							rm(deadRoot, { recursive: true, force: true }),
						);

						// Twice: the second call exercises the already-warned path.
						for (let attempt = 0; attempt < 2; attempt++) {
							const sessions = yield* store.listSessions();
							expect(sessions.map((session) => session.id).sort()).toEqual(
								[alive.id, dead.id].sort(),
							);
						}
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
			} finally {
				await rm(deadRoot, { recursive: true, force: true });
			}
		});
	});
});

describe("base refresh — a session whose directory was deleted", () => {
	test("does not fail the refresh callbacks or mark live sessions stale", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const upstream = await makeTestRepo();
			const deadRoot = await makeTestRepo();
			try {
				await sh(upstream, ["fetch", repoRoot, "main"]);
				await sh(upstream, ["reset", "--hard", "FETCH_HEAD"]);
				await sh(repoRoot, ["remote", "add", "origin", upstream]);
				await sh(repoRoot, ["fetch", "origin"]);
				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						// Straight into the review store so neither session has a prepared
						// base yet; the refresh below is the first to look at either.
						const open = (root: string) =>
							reviews.openSession({
								repoRoot: root,
								baseRef: "origin/main",
								headRef: "main",
								pr: null,
							});
						const alive = yield* open(repoRoot);
						const dead = yield* open(deadRoot);
						yield* Effect.promise(async () => {
							await rm(deadRoot, { recursive: true, force: true });
							await Bun.write(join(upstream, "new.ts"), "upstream\n");
							await sh(upstream, ["add", "-A"]);
							await sh(upstream, ["commit", "-q", "-m", "upstream moves"]);
						});
						const movedSessions: string[] = [];
						const staleSessions: string[] = [];
						const unsubscribe = subscribe((event) => {
							if (event.type === "session-files-changed")
								movedSessions.push(event.sessionId);
							if (event.type === "session-base-staleness-changed")
								staleSessions.push(event.sessionId);
						});
						yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

						expect(
							(yield* store.refreshSessionBase(alive.id)).baseMayBeStale,
						).toBe(false);
						expect(movedSessions).toContain(alive.id);
						expect(movedSessions).not.toContain(dead.id);
						expect(staleSessions).toEqual([]);
						expect(yield* store.readBaseMayBeStale(alive.id)).toBe(false);
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
			} finally {
				await rm(upstream, { recursive: true, force: true });
				await rm(deadRoot, { recursive: true, force: true });
			}
		});
	});
});

describe("Store — a PR session's worktree that moved on to another commit", () => {
	test("keeps uncommitted changes while the worktree holds the PR head, and diffs the PR head (reviewed files clean) once it doesn't", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			await sh(root, ["checkout", "-q", "-b", "pr"]);
			await Bun.write(join(root, "a.ts"), "pr change\n");
			await Bun.write(join(root, "b.ts"), "pr file\n");
			await sh(root, ["add", "-A"]);
			await sh(root, ["commit", "-q", "-m", "pr"]);
			const prHead = await shOut(root, ["rev-parse", "HEAD"]);
			// Uncommitted work: only meaningful while the worktree is still the PR's.
			await Bun.write(join(root, "uncommitted.ts"), "dirty\n");

			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviews = yield* ReviewStore;
					const settings = yield* SettingsStore;
					yield* settings.update({ includeUncommitted: true });
					const pr = { owner: "acme", repo: "widgets", number: 5 };
					const open = (headSha: string) => ({
						headSha,
						baseSha: "unused",
						state: "OPEN" as const,
					});
					const session = yield* reviews.openSession({
						repoRoot: root,
						baseRef: "main",
						headRef: "pr",
						pr: { ...pr, title: "A PR" },
					});
					const paths = (includeUncommitted: boolean) =>
						store
							.listChangedFiles(session.id, includeUncommitted)
							.pipe(Effect.map((files) => files.map((file) => file.path)));

					// Head not known yet: today's behavior, the worktree is trusted.
					expect(yield* paths(true)).toEqual([
						"a.ts",
						"b.ts",
						"uncommitted.ts",
					]);

					yield* store.recordPullRequestStatus(pr, open(prHead));
					expect(yield* paths(true)).toEqual([
						"a.ts",
						"b.ts",
						"uncommitted.ts",
					]);
					expect(yield* paths(false)).toEqual(["a.ts", "b.ts"]);

					// Snapshot taken from the worktree bytes (includeUncommitted on).
					yield* store.setFileViewed(session.id, "a.ts", true);

					const events: string[] = [];
					const unsubscribe = subscribe((event) => {
						if (event.type === "session-files-changed")
							events.push(event.sessionId);
					});
					yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

					// The worktree gets reused for an unrelated task.
					yield* Effect.promise(async () => {
						await sh(root, ["checkout", "-q", "-b", "other-task", "main"]);
						await Bun.write(join(root, "other.ts"), "other task\n");
						await sh(root, ["add", "other.ts"]);
						await sh(root, ["commit", "-q", "-m", "other"]);
						await Bun.write(join(root, "other-dirty.ts"), "dirty\n");
					});
					// Same PR head reported again: nothing changed, nothing to announce.
					yield* store.recordPullRequestStatus(pr, open(prHead));
					expect(events).toEqual([]);

					const files = yield* store.listChangedFiles(session.id, true);
					expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
					// Reviewed snapshot (worktree bytes) vs. the committed PR head.
					expect(
						files.find((file) => file.path === "a.ts")?.review,
					).toMatchObject({ viewed: true, changedSinceReview: false });
					const contents = yield* store.readFileContents(
						session.id,
						[{ path: "b.ts", force: false }],
						true,
					);
					expect(JSON.stringify(contents)).toContain("pr file");

					// A new push lands: the PR head moves, which a moved worktree
					// can't have anticipated either way.
					const pushed = yield* Effect.promise(async () => {
						await sh(root, ["checkout", "-q", "pr"]);
						await Bun.write(join(root, "b.ts"), "pr file, pushed\n");
						await sh(root, ["commit", "-q", "-am", "push"]);
						const sha = await shOut(root, ["rev-parse", "HEAD"]);
						await sh(root, ["checkout", "-q", "other-task"]);
						return sha;
					});
					yield* store.recordPullRequestStatus(pr, open(pushed));
					expect(events).toEqual([session.id]);

					// Back on the PR (descendant of the recorded head): worktree again.
					yield* Effect.promise(async () => {
						await rm(join(root, "other-dirty.ts"));
						await sh(root, ["checkout", "-q", "pr"]);
					});
					expect(yield* paths(true)).toEqual([
						"a.ts",
						"b.ts",
						"uncommitted.ts",
					]);
					expect(
						(yield* store.listChangedFiles(session.id, true)).find(
							(file) => file.path === "a.ts",
						)?.review,
					).toMatchObject({ viewed: true, changedSinceReview: false });
				}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
			);
		});
	});
});

describe("Store — a PR session after the PR is merged", () => {
	type MergeKind = "merge commit" | "squash" | "rebase";

	/**
	 * `main` is advanced in a second worktree so `repoRoot` stays checked out on
	 * the PR branch, the way a nisi PR worktree is after the merge.
	 */
	const mergeIntoMain = async (
		root: string,
		parent: string,
		kind: MergeKind,
		prCommits: ReadonlyArray<string>,
	) => {
		const mainWorktree = join(parent, "main-worktree");
		await sh(root, ["worktree", "add", "-q", mainWorktree, "main"]);
		await Bun.write(join(mainWorktree, "unrelated.ts"), "unrelated\n");
		await sh(mainWorktree, ["add", "-A"]);
		await sh(mainWorktree, ["commit", "-q", "-m", "unrelated"]);
		const baseSha = await shOut(mainWorktree, ["rev-parse", "HEAD"]);
		if (kind === "merge commit")
			await sh(mainWorktree, ["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
		if (kind === "squash") {
			await sh(mainWorktree, [
				"-c",
				"merge.ff=true",
				"merge",
				"-q",
				"--squash",
				"pr",
			]);
			await sh(mainWorktree, ["commit", "-q", "-m", "squash"]);
		}
		if (kind === "rebase")
			await sh(mainWorktree, ["cherry-pick", ...prCommits]);
		await Bun.write(join(mainWorktree, "later.ts"), "later\n");
		await sh(mainWorktree, ["add", "-A"]);
		await sh(mainWorktree, ["commit", "-q", "-m", "later"]);
		return baseSha;
	};

	const prFacts = (
		headSha: string,
		baseSha: string,
		state: "OPEN" | "MERGED",
	) => ({ headSha, baseSha, state });

	for (const kind of ["merge commit", "squash", "rebase"] as const) {
		test(`${kind}: the diff is the PR's changes and a reviewed file stays clean`, async () => {
			await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
				const root = await realpath(repoRoot);
				const parent = await mkdtemp(join(tmpdir(), "nisi-merged-pr-"));
				try {
					await sh(root, ["checkout", "-q", "-b", "pr"]);
					await Bun.write(join(root, "a.ts"), "pr change\n");
					await sh(root, ["commit", "-q", "-am", "pr a"]);
					const first = await shOut(root, ["rev-parse", "HEAD"]);
					await Bun.write(join(root, "b.ts"), "pr file\n");
					await sh(root, ["add", "-A"]);
					await sh(root, ["commit", "-q", "-m", "pr b"]);
					const head = await shOut(root, ["rev-parse", "HEAD"]);
					const mainBefore = await shOut(root, ["rev-parse", "main"]);

					await Effect.runPromise(
						Effect.gen(function* () {
							const store = yield* Store;
							const reviews = yield* ReviewStore;
							const pr = { owner: "acme", repo: "widgets", number: 9 };
							const session = yield* reviews.openSession({
								repoRoot: root,
								baseRef: "main",
								headRef: "pr",
								pr: { ...pr, title: "A PR" },
							});
							const paths = store
								.listChangedFiles(session.id, false)
								.pipe(Effect.map((files) => files.map((file) => file.path)));

							yield* store.recordPullRequestStatus(
								pr,
								prFacts(head, mainBefore, "OPEN"),
							);
							expect(yield* paths).toEqual(["a.ts", "b.ts"]);
							yield* store.setFileViewed(session.id, "a.ts", true);

							const baseSha = yield* Effect.promise(() =>
								mergeIntoMain(root, parent, kind, [first, head]),
							);
							// Merge-status hasn't reported the merge yet: today's base.
							// A merge commit makes the head an ancestor of main, so the
							// diff against the live base is empty.
							expect(yield* paths).toEqual(
								kind === "merge commit" ? [] : ["a.ts", "b.ts"],
							);

							const events: string[] = [];
							const unsubscribe = subscribe((event) => {
								if (event.type === "session-files-changed")
									events.push(event.sessionId);
							});
							yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
							yield* store.recordPullRequestStatus(
								pr,
								prFacts(head, baseSha, "MERGED"),
							);
							expect(events).toEqual([session.id]);

							expect(yield* paths).toEqual(["a.ts", "b.ts"]);
							const files = yield* store.listChangedFiles(session.id, false);
							expect(
								files.find((file) => file.path === "a.ts")?.review,
							).toMatchObject({ viewed: true, changedSinceReview: false });
							const contents = yield* store.readFileContents(
								session.id,
								[{ path: "a.ts", force: false }],
								false,
							);
							expect(JSON.stringify(contents)).toContain("pr change");
						}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
					);
				} finally {
					await rm(parent, { recursive: true, force: true });
				}
			});
		});
	}

	for (const kind of ["merge commit", "squash"] as const) {
		test(`${kind}: a checkout that is past the merge still diffs only the PR, uncommitted files excluded`, async () => {
			await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
				const root = await realpath(repoRoot);
				await sh(root, ["checkout", "-q", "-b", "pr"]);
				await Bun.write(join(root, "a.ts"), "pr change\n");
				await Bun.write(join(root, "b.ts"), "pr file\n");
				await sh(root, ["add", "-A"]);
				await sh(root, ["commit", "-q", "-m", "pr"]);
				const head = await shOut(root, ["rev-parse", "HEAD"]);

				// `repoRoot` itself ends up on `main`, past the merge.
				await sh(root, ["checkout", "-q", "main"]);
				await Bun.write(join(root, "unrelated.ts"), "unrelated\n");
				await sh(root, ["add", "-A"]);
				await sh(root, ["commit", "-q", "-m", "unrelated"]);
				const baseSha = await shOut(root, ["rev-parse", "HEAD"]);
				if (kind === "merge commit")
					await sh(root, ["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
				else {
					await sh(root, [
						"-c",
						"merge.ff=true",
						"merge",
						"-q",
						"--squash",
						"pr",
					]);
					await sh(root, ["commit", "-q", "-m", "squash"]);
				}
				await Bun.write(join(root, "later.ts"), "later\n");
				await sh(root, ["add", "-A"]);
				await sh(root, ["commit", "-q", "-m", "later"]);
				await Bun.write(join(root, "dirty.ts"), "uncommitted\n");

				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						const pr = { owner: "acme", repo: "widgets", number: 9 };
						const session = yield* reviews.openSession({
							repoRoot: root,
							baseRef: "main",
							headRef: "pr",
							pr: { ...pr, title: "A PR" },
						});
						yield* store.recordPullRequestStatus(
							pr,
							prFacts(head, baseSha, "MERGED"),
						);
						// Include-uncommitted asked for, but the worktree isn't this PR's.
						const files = yield* store.listChangedFiles(session.id, true);
						expect(files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
						expect(
							files.reduce((total, file) => total + file.additions, 0),
						).toBe(2);
						expect(
							JSON.stringify(
								yield* store.readFileContents(
									session.id,
									[{ path: "a.ts", force: false }],
									true,
								),
							),
						).toContain("pr change");
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
			});
		});
	}

	test("the first reading of a merged PR corrects the diff with session-diff-source-changed, not the Refresh event", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			const parent = await mkdtemp(join(tmpdir(), "nisi-first-reading-"));
			try {
				await sh(root, ["checkout", "-q", "-b", "pr"]);
				await Bun.write(join(root, "a.ts"), "pr change\n");
				await sh(root, ["commit", "-q", "-am", "pr a"]);
				const head = await shOut(root, ["rev-parse", "HEAD"]);
				const baseSha = await mergeIntoMain(root, parent, "merge commit", [
					head,
				]);

				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						const pr = { owner: "acme", repo: "widgets", number: 9 };
						const session = yield* reviews.openSession({
							repoRoot: root,
							baseRef: "main",
							headRef: "pr",
							pr: { ...pr, title: "A PR" },
						});
						const paths = store
							.listChangedFiles(session.id, false)
							.pipe(Effect.map((files) => files.map((file) => file.path)));
						// What the tab shows before any merge-status reading arrives.
						expect(yield* paths).toEqual([]);

						const events: string[] = [];
						const unsubscribe = subscribe((event) => {
							if (
								event.type === "session-files-changed" ||
								event.type === "session-diff-source-changed"
							)
								events.push(`${event.type}:${event.sessionId}`);
						});
						yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

						yield* store.recordPullRequestStatus(
							pr,
							prFacts(head, baseSha, "MERGED"),
						);
						expect(events).toEqual([
							`session-diff-source-changed:${session.id}`,
						]);
						expect(yield* paths).toEqual(["a.ts"]);
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		});
	});

	test("an open PR keeps the live base even after main moves", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			const parent = await mkdtemp(join(tmpdir(), "nisi-open-pr-"));
			try {
				await sh(root, ["checkout", "-q", "-b", "pr"]);
				await Bun.write(join(root, "a.ts"), "pr change\n");
				await sh(root, ["commit", "-q", "-am", "pr a"]);
				const head = await shOut(root, ["rev-parse", "HEAD"]);
				const mainBefore = await shOut(root, ["rev-parse", "main"]);
				const baseSha = await mergeIntoMain(root, parent, "squash", []);

				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						const pr = { owner: "acme", repo: "widgets", number: 9 };
						const session = yield* reviews.openSession({
							repoRoot: root,
							baseRef: "main",
							headRef: "pr",
							pr: { ...pr, title: "A PR" },
						});
						const events: string[] = [];
						const unsubscribe = subscribe((event) => {
							if (event.type === "session-files-changed")
								events.push(event.sessionId);
						});
						yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
						// Not MERGED: the base reading is ignored, whatever it says.
						yield* store.recordPullRequestStatus(
							pr,
							prFacts(head, mainBefore, "OPEN"),
						);
						yield* store.recordPullRequestStatus(
							pr,
							prFacts(head, baseSha, "OPEN"),
						);
						expect(events).toEqual([]);
						expect(
							(yield* store.listChangedFiles(session.id, false)).map(
								(file) => file.path,
							),
						).toEqual(["a.ts"]);
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		});
	});
});

describe("gatherGenerationContext — the worktree the agent will read", () => {
	const prSession = (root: string) => ({
		repoRoot: root,
		baseRef: "main",
		headRef: "pr",
		pr: { owner: "acme", repo: "widgets", number: 9, title: "A PR" },
	});
	const status = (
		headSha: string,
		baseSha: string,
		state: "OPEN" | "MERGED",
	) => ({ headSha, baseSha, state });

	/** `pr` has two commits off `main`; `main` is then advanced by a true merge of `pr`, in another worktree. */
	const setup = async (root: string, parent: string) => {
		await sh(root, ["checkout", "-q", "-b", "pr"]);
		await Bun.write(join(root, "a.ts"), "pr change\n");
		await Bun.write(join(root, "b.ts"), "pr file\n");
		await sh(root, ["add", "-A"]);
		await sh(root, ["commit", "-q", "-m", "pr"]);
		const head = await shOut(root, ["rev-parse", "HEAD"]);
		const baseSha = await shOut(root, ["rev-parse", "main"]);
		const mainWorktree = join(parent, "main-worktree");
		await sh(root, ["worktree", "add", "-q", mainWorktree, "main"]);
		await sh(mainWorktree, ["merge", "-q", "--no-ff", "-m", "merge", "pr"]);
		return { head, baseSha };
	};

	test("a merged PR's context lists the PR's files against the pinned base", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			const parent = await mkdtemp(join(tmpdir(), "nisi-walkthrough-ctx-"));
			try {
				const { head, baseSha } = await setup(root, parent);
				const context = await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						const session = yield* reviews.openSession(prSession(root));
						yield* store.recordPullRequestStatus(
							prSession(root).pr,
							status(head, baseSha, "MERGED"),
						);
						return yield* gatherGenerationContext(session.id);
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
				expect(context.files.map((file) => file.path)).toEqual([
					"a.ts",
					"b.ts",
				]);
				expect(context.baseRef).toBe(baseSha);
				expect(context.repoRoot).toBe(root);
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		});
	});

	test("refuses a PR session whose worktree moved on to another commit", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			const parent = await mkdtemp(join(tmpdir(), "nisi-walkthrough-ctx-"));
			try {
				const { head, baseSha } = await setup(root, parent);
				await sh(root, ["checkout", "-q", "-b", "other-task", baseSha]);
				await Bun.write(join(root, "other.ts"), "other\n");
				await sh(root, ["add", "-A"]);
				await sh(root, ["commit", "-q", "-m", "other"]);
				const result = await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const reviews = yield* ReviewStore;
						const session = yield* reviews.openSession(prSession(root));
						yield* store.recordPullRequestStatus(
							prSession(root).pr,
							status(head, baseSha, "OPEN"),
						);
						return yield* gatherGenerationContext(session.id).pipe(
							Effect.result,
						);
					}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
				);
				expect(Result.isFailure(result)).toBe(true);
				if (!Result.isFailure(result)) return;
				expect(result.failure).toMatchObject({
					_tag: "HeadNotCheckedOut",
					currentBranch: "other-task",
					pullRequestNumber: 9,
				});
			} finally {
				await rm(parent, { recursive: true, force: true });
			}
		});
	});

	test("trusts the worktree until the PR's head is known", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			await sh(root, ["checkout", "-q", "-b", "pr"]);
			await Bun.write(join(root, "a.ts"), "pr change\n");
			await sh(root, ["commit", "-q", "-am", "pr"]);
			await sh(root, ["checkout", "-q", "-b", "other-task", "main"]);
			const context = await Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					const session = yield* reviews.openSession(prSession(root));
					return yield* gatherGenerationContext(session.id);
				}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
			);
			expect(context.headRef).toBe("pr");
		});
	});

	test("still refuses a plain branch session whose head isn't checked out", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			await sh(root, ["branch", "feature"]);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					const session = yield* reviews.openSession({
						repoRoot: root,
						baseRef: "main",
						headRef: "feature",
						pr: null,
					});
					return yield* gatherGenerationContext(session.id).pipe(Effect.result);
				}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
			);
			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure).toMatchObject({
				_tag: "HeadNotCheckedOut",
				currentBranch: "main",
			});
			expect(
				(result.failure as { pullRequestNumber?: number }).pullRequestNumber,
			).toBeUndefined();
		});
	});
});

describe("Store.openSession — branch target with an explicit baseRef", () => {
	test("rejects an unresolvable base with InvalidBaseRef, carrying git's own stderr", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "totally-not-a-real-ref",
						}),
					);
				}).pipe(Effect.result, Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure._tag).toBe("InvalidBaseRef");
			if (result.failure._tag !== "InvalidBaseRef") return;
			expect(result.failure.baseRef).toBe("totally-not-a-real-ref");
			expect(result.failure.stderr.length).toBeGreaterThan(0);
		});
	});

	test("still opens normally when the explicit base resolves", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const session = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(session.target).toEqual({
				kind: "branch",
				baseRef: "main",
				headRef: "main",
			});
		});
	});
});

describe("Store.openSession — reuses matching branch review state for a PR", () => {
	const addOrigin = async (repoRoot: string) => {
		await sh(repoRoot, [
			"remote",
			"add",
			"origin",
			"https://github.com/acme/widgets.git",
		]);
		await sh(repoRoot, [
			"config",
			`url.${repoRoot}.insteadOf`,
			"https://github.com/acme/widgets.git",
		]);
	};

	test("auto open retargets a branch session, carries review state, and reuses it", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await addOrigin(repoRoot);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const branch = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
					yield* reviewStore.markFileViewed(
						branch.id,
						"a.ts",
						Option.some(new TextEncoder().encode("hello\n")),
					);
					const opened = yield* store.openSession(repoRoot, {
						kind: "auto",
					});
					const reopened = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "auto",
						}),
					);
					const state = yield* reviewStore.getFileReviewState(
						branch.id,
						"a.ts",
					);
					return { branch, opened, reopened, state };
				}).pipe(Effect.provide(makeTestLayer(dataDir, true))),
			);

			expect(result.opened.kind).toBe("retargeted");
			expect(result.opened.session.id).toBe(result.branch.id);
			expect(result.opened.session.target.kind).toBe("pr");
			expect(result.reopened.id).toBe(result.branch.id);
			expect(result.state?.viewed).toBe(true);
		});
	});

	test("auto open returns an existing PR session and closes the branch session", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await addOrigin(repoRoot);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const branch = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
					const prSession = yield* reviewStore.openSession({
						repoRoot: branch.repoRoot,
						baseRef: "main",
						headRef: "main",
						pr: {
							number: 42,
							title: "Add widgets",
							owner: "acme",
							repo: "widgets",
						},
					});
					const opened = yield* store.openSession(repoRoot, {
						kind: "auto",
					});
					return {
						branch,
						opened,
						openSessions: yield* reviewStore.listOpenSessions(),
						prSession,
					};
				}).pipe(Effect.provide(makeTestLayer(dataDir, true))),
			);

			expect(result.opened.session.id).toBe(result.prSession.id);
			expect(result.opened.kind).toBe("existing");
			expect(result.openSessions.map((session) => session.id)).toEqual([
				result.prSession.id,
			]);
		});
	});

	test("an explicit branch target remains branch-keyed when a PR is open", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await addOrigin(repoRoot);
			const session = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* openedSession(
						store.openSession(repoRoot, { kind: "branch" }),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir, true))),
			);

			expect(session.target.kind).toBe("branch");
		});
	});
});

describe("Store.openPullRequestSession — reuses open review sessions", () => {
	for (const changedHead of [false, true]) {
		test(`indexed deep link is GitHub-free in foreground and revalidates by number (${changedHead ? "head changes" : "title changes"})`, async () => {
			await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
				await sh(repoRoot, ["remote", "add", "origin", repoRoot]);
				await sh(repoRoot, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
				await sh(repoRoot, ["branch", "feature"]);
				const featurePath = join(dataDir, "feature-worktree");
				await sh(repoRoot, ["worktree", "add", featurePath, "feature"]);
				const canonicalRoot = await realpath(repoRoot);
				const canonicalFeature = await realpath(featurePath);
				const calls = { pr: 0 };
				const index: Context.Service.Shape<typeof PrIndex> = {
					lookup: () =>
						Effect.die(
							new Error("deep links must not probe local branch index keys"),
						),
					lookupPullRequest: (owner, repo, number) =>
						Effect.sync(() => {
							expect(owner.toLowerCase()).toBe("acme");
							expect(repo.toLowerCase()).toBe("widgets");
							expect(number).toBe(42);
							return {
								repository: {
									owner: "acme",
									repo: "widgets",
									defaultBranch: "main",
								},
								pr: {
									number: 42,
									title: "Cached",
									baseRef: "main",
									headRef: "main",
									isCrossRepository: false,
									headOwner: "acme",
								},
							};
						}),
					refresh: () => Effect.succeed(undefined),
					refreshKnown: Effect.void,
					start: Effect.never,
				};
				await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const review = yield* ReviewStore;
						const settings = yield* SettingsStore;
						yield* settings.setRepoPath("acme", "widgets", repoRoot);
						const opened = yield* store.openPullRequestSession({
							owner: "ACME",
							repo: "Widgets",
							number: 42,
						});
						expect(opened.status).toBe("opened");
						if (opened.status !== "opened")
							return yield* Effect.die(new Error("Expected indexed open"));
						expect(calls.pr).toBe(0);
						expect(opened.outcome.session.repoRoot).toBe(canonicalRoot);
						expect(opened.outcome.session.target.kind).toBe("pr");
						yield* review.markFileViewed(
							opened.outcome.session.id,
							"a.ts",
							Option.some(new TextEncoder().encode("hello\n")),
						);
						const before = yield* review.getFileReviewState(
							opened.outcome.session.id,
							"a.ts",
						);
						const corrected = yield* Deferred.make<OpenSessionOutcome>();
						yield* store.forkRevalidation(opened.outcome.session, (outcome) =>
							Deferred.succeed(corrected, outcome).pipe(Effect.asVoid),
						);
						const result = yield* Deferred.await(corrected);
						expect(calls.pr).toBe(1);
						expect(result.session.target).toMatchObject({
							kind: "pr",
							number: 42,
							title: "Fresh",
							headRef: changedHead ? "feature" : "main",
						});
						expect(result.session.repoRoot).toBe(
							changedHead ? canonicalFeature : canonicalRoot,
						);
						if (changedHead) {
							expect(result.session.id).not.toBe(opened.outcome.session.id);
							expect(
								yield* review.getFileReviewState(result.session.id, "a.ts"),
							).toBeNull();
							expect(
								(yield* review.listOpenSessions()).some(
									(session) => session.id === opened.outcome.session.id,
								),
							).toBe(false);
						} else {
							expect(result.session.id).toBe(opened.outcome.session.id);
							expect(
								yield* review.getFileReviewState(result.session.id, "a.ts"),
							).toEqual(before);
						}
					}).pipe(
						Effect.provide(
							makeTestLayer(
								dataDir,
								{
									...mockGitHub,
									repository: () =>
										Effect.die(
											new Error("deep link must not fetch repository metadata"),
										),
									pullRequest: (root, number) =>
										Effect.sync(() => {
											expect(root).toBe(repoRoot);
											expect(number).toBe(42);
											calls.pr++;
											return {
												number: 42,
												title: "Fresh",
												baseRef: "main",
												headRef: changedHead ? "feature" : "main",
												isCrossRepository: false,
											};
										}),
								},
								index,
							),
						),
					),
				);
			});
		});
	}
	for (const missingResult of ["failure", "null"] as const) {
		test(`a missing PR (${missingResult}) surfaces PullRequestNotFound without a head-ref lookup`, async () => {
			await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
				const failure = new PullRequestNotFound({
					repoRoot,
					number: 42,
					reason: "PR no longer exists",
				});
				const result = await Effect.runPromise(
					Effect.gen(function* () {
						const store = yield* Store;
						const settings = yield* SettingsStore;
						yield* settings.setRepoPath("acme", "widgets", repoRoot);
						return yield* store.openPullRequestSession({
							owner: "acme",
							repo: "widgets",
							number: 42,
						});
					}).pipe(
						Effect.result,
						Effect.provide(
							makeTestLayer(dataDir, {
								...mockGitHub,
								pullRequest: () =>
									missingResult === "failure" ? failure : Effect.succeed(null),
								headRef: () => Effect.die(new Error("must not fetch head")),
							}),
						),
					),
				);
				expect(Result.isFailure(result)).toBe(true);
				if (!Result.isFailure(result)) return;
				expect(result.failure._tag).toBe("PullRequestNotFound");
				if (missingResult === "failure") expect(result.failure).toBe(failure);
			});
		});
	}

	test("returns an existing PR in another root by case-insensitive identity without GitHub calls", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const settings = yield* SettingsStore;
					yield* settings.setRepoPath("acme", "widgets", repoRoot);
					const existing = yield* reviewStore.openSession({
						repoRoot: join(dataDir, "another-root"),
						baseRef: "main",
						headRef: "feature",
						pr: {
							number: 42,
							title: "Existing",
							owner: "Acme",
							repo: "Widgets",
						},
					});
					const opened = yield* store.openPullRequestSession({
						owner: "acme",
						repo: "widgets",
						number: 42,
					});
					expect(opened.status).toBe("opened");
					if (opened.status !== "opened") return;
					expect(opened.outcome.kind).toBe("opened");
					expect(opened.outcome.session.id).toBe(existing.id);
					expect((yield* reviewStore.listOpenSessions()).length).toBe(1);
				}).pipe(
					Effect.provide(
						makeTestLayer(dataDir, {
							...mockGitHub,
							pullRequest: () => Effect.die(new Error("must not fetch PR")),
							headRef: () => Effect.die(new Error("must not fetch head")),
						}),
					),
				),
			);
		});
	});

	for (const scenario of [
		"matching",
		"other-branch",
		"fork",
		"unrelated",
		"missing",
		"no-session",
	] as const) {
		test(`${scenario}: only a same-repository checkout on the PR head is retargeted`, async () => {
			await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
				await sh(repoRoot, [
					"remote",
					"add",
					"origin",
					"https://github.com/acme/widgets.git",
				]);
				await sh(repoRoot, [
					"config",
					`url.${repoRoot}.insteadOf`,
					"https://github.com/acme/widgets.git",
				]);
				await sh(repoRoot, ["branch", "feature"]);
				await sh(repoRoot, ["update-ref", "refs/pull/42/head", "feature"]);
				const sibling = join(dataDir, "branch-worktree");
				await sh(repoRoot, ["worktree", "add", sibling, "feature"]);
				if (scenario === "other-branch")
					await sh(sibling, ["checkout", "-b", "other"]);
				const unrelated =
					scenario === "unrelated" ? await makeTestRepo() : null;
				const reads = { pr: 0 };
				try {
					await Effect.runPromise(
						Effect.gen(function* () {
							const store = yield* Store;
							const reviewStore = yield* ReviewStore;
							const settings = yield* SettingsStore;
							yield* settings.setRepoPath("acme", "widgets", repoRoot);
							const source =
								scenario === "no-session"
									? null
									: yield* reviewStore.openSession({
											repoRoot:
												scenario === "missing"
													? join(dataDir, "gone")
													: (unrelated ?? sibling),
											baseRef: "main",
											headRef: "feature",
											pr: null,
										});
							if (source !== null) {
								yield* reviewStore.markFileViewed(
									source.id,
									"a.ts",
									Option.some(new TextEncoder().encode("hello\n")),
								);
							}
							const before =
								source === null
									? null
									: yield* reviewStore.getFileReviewState(source.id, "a.ts");
							const opened = yield* store.openPullRequestSession({
								owner: "acme",
								repo: "widgets",
								number: 42,
							});
							expect(reads.pr).toBe(1);
							expect(opened.status).toBe("opened");
							if (opened.status !== "opened") return;
							expect(opened.outcome.session.target.kind).toBe("pr");
							if (scenario === "matching" && source !== null) {
								expect(opened.outcome.kind).toBe("retargeted");
								expect(opened.outcome.session.id).toBe(source.id);
								expect(opened.outcome.session.repoRoot).toBe(source.repoRoot);
								expect(
									yield* reviewStore.getFileReviewState(source.id, "a.ts"),
								).toEqual(before);
							} else {
								expect(opened.outcome.kind).toBe("opened");
								expect(opened.outcome.session.id).not.toBe(source?.id);
								expect(opened.outcome.session.repoRoot).not.toBe(sibling);
								expect(
									yield* reviewStore.getFileReviewState(
										opened.outcome.session.id,
										"a.ts",
									),
								).toBeNull();
								if (source !== null)
									expect(
										(yield* reviewStore.getSession(source.id)).pr,
									).toBeNull();
							}
						}).pipe(
							Effect.provide(
								makeTestLayer(dataDir, {
									...mockGitHub,
									repository: () =>
										Effect.die(
											new Error("known PR must not look up repository again"),
										),
									pullRequest: () =>
										Effect.sync(() => {
											reads.pr++;
											return {
												number: 42,
												title: "Add widgets",
												baseRef: "main",
												headRef: "feature",
												isCrossRepository: scenario === "fork",
											};
										}),
									headRef: () =>
										Effect.die(new Error("must reuse the fetched PR head")),
								}),
							),
						),
					);
				} finally {
					if (unrelated !== null)
						await rm(unrelated, { recursive: true, force: true });
				}
			});
		});
	}
});

test("range claims change the Files Changed patch for a single added line", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		const baseLines = Array.from(
			{ length: 45 },
			(_, index) => `line ${index + 1}`,
		);
		await Bun.write(join(repoRoot, "a.ts"), `${baseLines.join("\n")}\n`);
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "base lines"]);
		await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
		const headLines = [...baseLines];
		headLines.splice(41, 0, "selected addition");
		headLines[4] = "another change";
		await Bun.write(join(repoRoot, "a.ts"), `${headLines.join("\n")}\n`);
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "changes"]);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				const session = yield* openedSession(
					store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					}),
				);
				const before = yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
				yield* store.setRangeViewed(
					session.id,
					"a.ts",
					"selection:test",
					"Selection L42",
					[{ startLine: 42, endLine: 42 }],
					true,
				);
				const after = yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
				yield* store.setRangeViewed(
					session.id,
					"a.ts",
					"selection:test",
					"Selection L42",
					[{ startLine: 42, endLine: 42 }],
					false,
				);
				yield* store.setRangeViewed(
					session.id,
					"a.ts",
					"walkthrough:block",
					"Walkthrough block",
					[{ startLine: 42, endLine: 42 }],
					true,
				);
				const walkthroughAfter = yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
				return {
					before: before[0]?.content,
					after: after[0]?.content,
					walkthroughAfter: walkthroughAfter[0]?.content,
				};
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);
		expect(result.before?.patch).toContain("+selected addition");
		expect(result.after?.review?.baselineKind).toBe("reviewed");
		expect(result.after?.review?.ranges).toContainEqual({
			startLine: 42,
			endLine: 42,
			status: "reviewed",
			reviewedVia: {
				kind: "range",
				blockId: "selection:test",
				blockLabel: "Selection L42",
			},
		});
		expect(result.after?.patch).not.toContain("+selected addition");
		expect(result.after?.patch).toContain("+another change");
		expect(result.walkthroughAfter?.review?.baselineKind).toBe("reviewed");
		expect(result.walkthroughAfter?.patch).not.toContain("+selected addition");
	});
});

test("a post-review edit to the same line removes the reviewed version, not the base version", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		await Bun.write(join(repoRoot, "a.ts"), "value = 0;\nunchanged\n");
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "base value"]);
		await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
		const reviewed = "value = 1;\nunchanged\n";
		await Bun.write(join(repoRoot, "a.ts"), reviewed);
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "reviewed value"]);

		const session = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				const opened = yield* openedSession(
					store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					}),
				);
				yield* store.setFileViewed(opened.id, "a.ts", true);
				return opened;
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);
		await Bun.write(
			join(repoRoot, "a.ts"),
			"value = 2;\nunchanged\nafterReview\n",
		);
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "post-review edit"]);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				return yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);
		const content = result[0]?.content;
		expect(content?.review?.baselineKind).toBe("reviewed");
		expect(content?.review?.changedSinceReview).toBe(true);
		expect(content?.oldContent).toBe(reviewed);
		expect(content?.patch).toContain("-value = 1;");
		expect(content?.patch).not.toContain("-value = 0;");
		expect(content?.patch).toContain("+value = 2;");
	});
});

test("a walkthrough claim and a whole-file tick both produce the empty reviewed patch", async () => {
	await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
		await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
		await Bun.write(join(repoRoot, "a.ts"), "hello\nadded line\n");
		await sh(repoRoot, ["add", "-A"]);
		await sh(repoRoot, ["commit", "-q", "-m", "add line"]);

		const result = await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* Store;
				const session = yield* openedSession(
					store.openSession(repoRoot, {
						kind: "branch",
						baseRef: "main",
					}),
				);
				yield* store.setRangeViewed(
					session.id,
					"a.ts",
					"walkthrough:block",
					"Block",
					[{ startLine: 2, endLine: 2 }],
					true,
				);
				const walkthrough = yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
				yield* store.setRangeViewed(
					session.id,
					"a.ts",
					"walkthrough:block",
					"Block",
					[{ startLine: 2, endLine: 2 }],
					false,
				);
				yield* store.setFileViewed(session.id, "a.ts", true);
				const wholeFile = yield* store.readFileContents(
					session.id,
					[{ path: "a.ts", force: false }],
					false,
				);
				return {
					walkthrough: walkthrough[0]?.content,
					wholeFile: wholeFile[0]?.content,
				};
			}).pipe(Effect.provide(makeTestLayer(dataDir))),
		);

		expect(result.walkthrough?.review?.baselineKind).toBe("reviewed");
		expect(result.walkthrough?.patch).toBe("");
		expect(result.wholeFile?.review?.baselineKind).toBe("reviewed");
		expect(result.wholeFile?.patch).toBe("");
	});
});

describe("Store.openSession — branch target with an explicit headRef (two arbitrary refs)", () => {
	test("rejects an unresolvable head with InvalidHeadRef, carrying git's own stderr", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
							headRef: "totally-not-a-real-ref",
						}),
					);
				}).pipe(Effect.result, Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result)).toBe(true);
			if (!Result.isFailure(result)) return;
			expect(result.failure._tag).toBe("InvalidHeadRef");
			if (result.failure._tag !== "InvalidHeadRef") return;
			expect(result.failure.headRef).toBe("totally-not-a-real-ref");
			expect(result.failure.stderr.length).toBeGreaterThan(0);
		});
	});

	test("opens with the explicit head as-is, regardless of what's actually checked out", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "b.ts"), "on feature\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);
			// The actual checkout is a third branch, neither side of the diff.
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);

			const session = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
							headRef: "feature",
						}),
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(session.target).toEqual({
				kind: "branch",
				baseRef: "main",
				headRef: "feature",
			});
		});
	});

	test("listChangedFiles diffs the named head, never overlaying uncommitted edits on the actual checkout", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "b.ts"), "on feature\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// The actual checkout is a third branch, dirtied on top — none of
			// this belongs to the main..feature diff and must never leak in,
			// even when `includeUncommitted` is requested.
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);
			await Bun.write(join(repoRoot, "a.ts"), "dirtied, never committed\n");

			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
							headRef: "feature",
						}),
					);
					return yield* store.listChangedFiles(session.id, true);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			const byPath = new Map(files.map((file) => [file.path, file]));
			expect(byPath.get("b.ts")?.status).toBe("added");
			expect(byPath.has("a.ts")).toBe(false);
		});
	});
});

/**
 * Regression coverage for the corruption `resolveDiffHead`
 * (`apps/desktop/sidecar/diff-head.ts`) exists to prevent: `setFileViewed`/
 * `setRangeViewed` used to read `readWorktreeBlobContent` unconditionally,
 * so a session whose head wasn't what `repoRoot` actually had checked out —
 * an explicit `<base>..<head>` session, or an ordinary session the caller
 * checked a different branch out from mid-session — would silently
 * snapshot the wrong branch's content on tick.
 */
describe("Store — tracked-changes writes never snapshot the wrong branch's content", () => {
	test("setFileViewed on an explicit non-checkout head snapshots headRef's content, not the live checkout", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// The actual checkout is a third branch, dirtied on top — none of
			// this may ever leak into a snapshot for a session whose head is
			// the explicit "feature".
			await sh(repoRoot, ["checkout", "-q", "-b", "working", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"dirtied on working, never committed\n",
			);

			const snapshotText = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
							headRef: "feature",
						}),
					);
					yield* store.setFileViewed(session.id, "a.ts", true);
					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					return new TextDecoder().decode(snapshot);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(snapshotText).toBe("feature content\n");
		});
	});

	test("setFileViewed on an ordinary session snapshots headRef's content once the caller checks a different branch out mid-session", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			// Opened while "feature" is checked out — headRef == "feature",
			// the same as any ordinary `nisi diff` session today.
			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
						}),
					);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The caller drifts away mid-session, without closing the tab —
			// before the fix, this alone was enough to corrupt a tick, since
			// the write path always followed the live checkout.
			await sh(repoRoot, ["checkout", "-q", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"drifted onto main, never committed\n",
			);

			const snapshotText = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					yield* store.setFileViewed(sessionId, "a.ts", true);
					const state = yield* reviewStore.getFileReviewState(
						sessionId,
						"a.ts",
					);
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					return new TextDecoder().decode(snapshot);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(snapshotText).toBe("feature content\n");
		});
	});

	test("setRangeViewed reconciles against the correct merge-base and headRef content once the caller has drifted", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			// `main` keeps moving (and touching a.ts) after "feature" branches
			// off — the merge-base regression only shows up when `main`'s own
			// tip differs from `merge-base(main, feature)`, in a way that
			// introduces a *second*, unrelated change to a.ts (a pure trailing
			// deletion wouldn't be enough — see the range-claim reasoning below).
			await Bun.write(join(repoRoot, "a.ts"), "line1\nline2\nline3\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "three lines on main"]);

			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "line1\nline2 CHANGED\nline3\n");
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "on feature"]);

			await sh(repoRoot, ["checkout", "-q", "main"]);
			await Bun.write(
				join(repoRoot, "a.ts"),
				"line1 CHANGED ON MAIN\nline2\nline3\n",
			);
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "main advanced"]);

			// Session opened while "feature" is checked out.
			await sh(repoRoot, ["checkout", "-q", "feature"]);
			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// Drift to "main", which has since moved past the true
			// merge-base(main, feature) — the case that exposed the bug.
			await sh(repoRoot, ["checkout", "-q", "main"]);

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					// Only claims line 2 — feature's one real change relative
					// to the *correct* merge-base. Against the wrong base
					// (main's own drifted tip, which also differs from feature
					// on line 1), reconciliation would find an extra
					// unreviewed line-1 hunk this claim never covers.
					yield* store.setRangeViewed(
						sessionId,
						"a.ts",
						"block-1",
						"Block 1",
						[{ startLine: 2, endLine: 2 }],
						true,
					);
					const claims = yield* reviewStore.listRangeClaims(sessionId, "a.ts");
					const claim = claims.find((c) => c.blockId === "block-1");
					if (claim === undefined) {
						return yield* Effect.die("expected a range claim");
					}
					const snapshot = yield* reviewStore.readSnapshot(claim.snapshotHash);
					const fileState = yield* reviewStore.getFileReviewState(
						sessionId,
						"a.ts",
					);
					return {
						rangeSnapshotText: new TextDecoder().decode(snapshot),
						wholeFileAutoTicked: fileState?.viewed ?? false,
					};
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The range claim itself must snapshot "feature"'s content, not
			// whatever's dirtied on the live "main" checkout.
			expect(result.rangeSnapshotText).toBe("line1\nline2 CHANGED\nline3\n");
			// Claiming just line 2 fully covers merge-base(main,
			// feature)..feature's one real hunk, so the whole-file claim
			// should auto-tick — which only happens if reconciliation used
			// that correct base rather than merge-base(main, HEAD) against a
			// drifted "main" that also differs from feature on line 1.
			expect(result.wholeFileAutoTicked).toBe(true);
		});
	});
});

describe("Store.setFileViewed — a committed symlink", () => {
	test("stays reviewed on the next read instead of immediately reporting changedSinceReview", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			// `link.txt` is added on a feature branch cut from `main` — needed so
			// it actually shows up in `listChangedFiles`' base..head diff, not
			// just sitting unchanged in the repo's one existing commit.
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "target.txt"), "target content\n");
			await symlink("target.txt", join(repoRoot, "link.txt"));
			await sh(repoRoot, ["add", "-A"]);
			await sh(repoRoot, ["commit", "-q", "-m", "add symlink"]);

			const files = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
						}),
					);
					yield* store.setFileViewed(session.id, "link.txt", true);
					return yield* store.listChangedFiles(session.id, false);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			const linkFile = files.find((file) => file.path === "link.txt");
			expect(linkFile?.review?.viewed).toBe(true);
			expect(linkFile?.review?.changedSinceReview).toBe(false);
		});
	});
});

describe("Store.setFileViewed — working-tree read failures", () => {
	/**
	 * Puts `a.ts` in the session's diff (changed between `main` and a
	 * `feature` branch checked out on top of it) without touching what's
	 * actually on disk right now — each test below mutates the working tree
	 * itself (deletes the file, or replaces it with a directory) after this,
	 * so `a.ts` stays a real diff entry while its current working-tree state
	 * diverges from both `main` and `feature`'s committed content.
	 */
	const makeRepoWithChangedFile = async (repoRoot: string): Promise<void> => {
		await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
		await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
		await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);
	};

	test('ticking Reviewed on a path absent from the working tree records a NULL snapshot, not sha256(""), and still reports it reviewed while absent', async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await makeRepoWithChangedFile(repoRoot);
			await rm(join(repoRoot, "a.ts"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const settingsStore = yield* SettingsStore;
					// `includeUncommitted: true` — "current" has to mean the
					// working tree (still missing the file) for both the write
					// and the read to exercise the absent-stays-reviewed path;
					// committed-only mode would read `a.ts` from `feature`'s
					// committed tree instead, where it still exists.
					yield* settingsStore.update({ includeUncommitted: true });

					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);

					yield* store.setFileViewed(session.id, "a.ts", true);

					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					const files = yield* store.listChangedFiles(session.id, true);
					const file = files.find((f) => f.path === "a.ts");
					return { state, review: file?.review ?? null };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(result.state?.viewed).toBe(true);
			expect(result.state?.snapshotHash).toBeNull();
			expect(result.review).toEqual({
				viewed: true,
				reviewedHash: null,
				changedSinceReview: false,
			});
		});
	});

	test("ticking Reviewed on a path that's actually a directory propagates the read failure instead of recording an empty snapshot", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await makeRepoWithChangedFile(repoRoot);
			await rm(join(repoRoot, "a.ts"));
			await mkdir(join(repoRoot, "a.ts"));

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const settingsStore = yield* SettingsStore;
					// Worktree mode — a directory colliding with the tracked path
					// is only a read failure when the write actually touches the
					// worktree; committed-only mode reads the git object instead
					// and never sees the stray directory on disk.
					yield* settingsStore.update({ includeUncommitted: true });

					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);

					const outcome = yield* store
						.setFileViewed(session.id, "a.ts", true)
						.pipe(Effect.result);
					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					return { outcome, state };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(Result.isFailure(result.outcome)).toBe(true);
			// Never recorded as a claim at all — a swallowed error would have
			// left a `viewed: true` row (empty-content snapshot) behind.
			expect(result.state).toBeNull();
		});
	});
});

/**
 * Regression coverage for the bug `readCurrentContent`'s consolidation
 * (`apps/desktop/sidecar/store.ts`) fixed: `setFileViewed`/`setRangeViewed`
 * used to snapshot via a helper that read the worktree whenever the session
 * was worktree-eligible, regardless of the `includeUncommitted` setting,
 * while `listChangedFiles`'s `attachReviewState` only read the worktree when
 * `includeUncommitted` was *also* on. With the setting off (the default),
 * ticking Reviewed snapshotted the worktree while the very next read
 * compared against HEAD's committed tree, so a deleted-but-still-present-
 * on-disk file (e.g. a gitignored leftover at the same path) reported
 * "Modified after review" immediately, with nothing about the committed
 * diff actually different. Both the write and the read now derive "current
 * content" from the same gate, and the changed-since-review comparison
 * (`hasChangedSinceReview`) treats absence symmetrically instead of
 * standing in `hashContent(new Uint8Array())` for it — a real hash that
 * could never equal a real snapshot.
 */
describe("Store — setFileViewed and listChangedFiles agree on 'current content'", () => {
	test("reviewed-then-still-deleted: stays unchanged in committed-only mode even with a stray untracked file at that path", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await rm(join(repoRoot, "a.ts"));
			await sh(repoRoot, ["commit", "-q", "-am", "delete a.ts"]);

			// A leftover, untracked file at the same path (e.g. gitignored) —
			// physically present on disk despite being deleted from git's
			// history. `includeUncommitted` defaults to `false`, so neither the
			// write nor the read below may ever look at this.
			await Bun.write(join(repoRoot, "a.ts"), "stray untracked content\n");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);

					yield* store.setFileViewed(session.id, "a.ts", true);

					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					const files = yield* store.listChangedFiles(session.id, false);
					const file = files.find((f) => f.path === "a.ts");
					return { state, review: file?.review ?? null };
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(result.state?.snapshotHash).toBeNull();
			expect(result.review).toEqual({
				viewed: true,
				reviewedHash: null,
				changedSinceReview: false,
			});
		});
	});

	test("a committed-only tick never snapshots a dirty uncommitted edit sitting in the worktree", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "feature content\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);

			// Dirtied on top, never committed — with `includeUncommitted: false`
			// this must be invisible to both the write and the read.
			await Bun.write(join(repoRoot, "a.ts"), "dirtied, never committed\n");

			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviewStore = yield* ReviewStore;
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);

					yield* store.setFileViewed(session.id, "a.ts", true);

					const state = yield* reviewStore.getFileReviewState(
						session.id,
						"a.ts",
					);
					if (state === null || state.snapshotHash === null) {
						return yield* Effect.die("expected a snapshot hash");
					}
					const snapshot = yield* reviewStore.readSnapshot(state.snapshotHash);
					const files = yield* store.listChangedFiles(session.id, false);
					const file = files.find((f) => f.path === "a.ts");
					return {
						snapshotText: new TextDecoder().decode(snapshot),
						changedSinceReview: file?.review?.changedSinceReview ?? null,
					};
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The snapshot must be `feature`'s committed content, not the dirty
			// worktree edit — and the immediate read must agree.
			expect(result.snapshotText).toBe("feature content\n");
			expect(result.changedSinceReview).toBe(false);
		});
	});

	test("a file that reappears after being reviewed while absent is reported changed", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);
			await rm(join(repoRoot, "a.ts"));

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const settingsStore = yield* SettingsStore;
					// Worktree mode, so the write sees the file as genuinely
					// absent right now (not merely absent from HEAD).
					yield* settingsStore.update({ includeUncommitted: true });
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
					yield* store.setFileViewed(session.id, "a.ts", true);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			// The file shows back up on disk, uncommitted.
			await Bun.write(join(repoRoot, "a.ts"), "back again\n");

			const changedSinceReview = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const files = yield* store.listChangedFiles(sessionId, true);
					return (
						files.find((f) => f.path === "a.ts")?.review?.changedSinceReview ??
						null
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(changedSinceReview).toBe(true);
		});
	});

	test("a file deleted after being reviewed while present is reported changed", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			await sh(repoRoot, ["checkout", "-q", "-b", "feature"]);
			await Bun.write(join(repoRoot, "a.ts"), "hello\nworld\n");
			await sh(repoRoot, ["commit", "-q", "-am", "change a.ts"]);

			const sessionId = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const settingsStore = yield* SettingsStore;
					yield* settingsStore.update({ includeUncommitted: true });
					const session = yield* openedSession(
						store.openSession(repoRoot, {
							kind: "branch",
							baseRef: "main",
						}),
					);
					yield* store.setFileViewed(session.id, "a.ts", true);
					return session.id;
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			await rm(join(repoRoot, "a.ts"));

			const changedSinceReview = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const files = yield* store.listChangedFiles(sessionId, true);
					return (
						files.find((f) => f.path === "a.ts")?.review?.changedSinceReview ??
						null
					);
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(changedSinceReview).toBe(true);
		});
	});
});

describe("Store.openPullRequestSession — repo path resolution", () => {
	test("returns needs-repo-path when owner/repo is unknown and nothing can be inferred, without ever shelling out to gh", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "nisi-sidecar-store-data-"));
		try {
			const outcome = await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					return yield* store.openPullRequestSession({
						owner: "fdarian",
						repo: "nisi",
						number: 1,
					});
				}).pipe(Effect.provide(makeTestLayer(dataDir))),
			);

			expect(outcome).toEqual({
				status: "needs-repo-path",
				owner: "fdarian",
				repo: "nisi",
			});
		} finally {
			await rm(dataDir, { recursive: true, force: true });
		}
	});
});

describe("Store — persisting the PR state it learns", () => {
	test("a merge-status reading is saved on every session of that PR, closed tabs included", async () => {
		await withTestRepoAndDataDir(async (repoRoot, dataDir) => {
			const root = await realpath(repoRoot);
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* Store;
					const reviews = yield* ReviewStore;
					const pr = { owner: "Acme", repo: "Widgets", number: 5 };
					const session = yield* reviews.openSession({
						repoRoot: root,
						baseRef: "main",
						headRef: "main",
						pr: { ...pr, title: "A PR" },
					});
					yield* reviews.closeSession(session.id);

					yield* store.recordPullRequestStatus(
						{ ...pr, owner: "acme" },
						{ headSha: "head", baseSha: "base", state: "MERGED" },
					);

					const [record] = yield* reviews.listPullRequestSessions(pr);
					expect(record?.prState).toBe("merged");
				}).pipe(Effect.scoped, Effect.provide(makeTestLayer(dataDir))),
			);
		});
	});
});
