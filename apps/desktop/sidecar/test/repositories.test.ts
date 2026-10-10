import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import {
	GhNotAuthenticated,
	GitHub,
	type GitHubShape,
	GitHubUnreachable,
	PullRequestNotFound,
} from "@repo/git";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
import { ConfigProvider, type Context, Effect, Layer, Stream } from "effect";
import { PrIndex } from "../pr-index.ts";
import {
	collectRepositories,
	getRepository,
	listRepositories,
	sortByActivity,
	streamSessionStates,
} from "../repositories.ts";

const sh = async (cwd: string, args: ReadonlyArray<string>) => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	if ((await proc.exited) !== 0)
		throw new Error(
			`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`,
		);
};

/** A clone-shaped directory with an `origin` remote and one commit. */
const makeCheckout = async (origin: string | null) => {
	const root = await mkdtemp(join(tmpdir(), "nisi-repositories-repo-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);
	await Bun.write(join(root, "a.ts"), "hello\n");
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", "base"]);
	if (origin !== null) await sh(root, ["remote", "add", "origin", origin]);
	return await realpath(root);
};

const unused = () => Effect.die(new Error("unused mock GitHub method"));
const unusedStream = () => Stream.die(new Error("unused mock GitHub method"));

const githubWith = (
	overrides: Partial<
		Pick<GitHubShape, "pullRequestState" | "pullRequestStates">
	> = {},
): GitHubShape => ({
	listOpenPullRequests: unused,
	getActionsJob: unused,
	getActionsJobLogs: unused,
	rerunActionsJob: unused,
	repository: unused,
	pullRequest: unused,
	pullRequestState: unused,
	pullRequestStates: unused,
	headRef: unused,
	search: unused,
	checks: unused,
	checksSnapshot: unused,
	approveWorkflowRuns: unused,
	overview: unused,
	stack: unused,
	mergeability: unused,
	mergeMethods: unused,
	merge: unused,
	mergeStack: unused,
	markReady: unused,
	watchChecks: unusedStream,
	watchMergeStatus: unusedStream,
	watchStack: unusedStream,
	watchOverview: unusedStream,
	...overrides,
});

const indexWithOpen = (
	openNumbers: ReadonlyArray<number>,
): Context.Service.Shape<typeof PrIndex> => ({
	lookup: () => Effect.succeed(undefined),
	lookupPullRequest: (owner, repo, number) =>
		Effect.succeed(
			openNumbers.includes(number)
				? {
						repository: { owner, repo, defaultBranch: "main" },
						pr: {
							number,
							title: "",
							baseRef: "main",
							headRef: "main",
							isCrossRepository: false,
							headOwner: owner,
						},
					}
				: undefined,
		),
	refresh: () => Effect.succeed(undefined),
	refreshKnown: Effect.void,
	start: Effect.never,
});

const makeLayer = (
	dataDir: string,
	github: GitHubShape,
	index: Context.Service.Shape<typeof PrIndex>,
) =>
	Layer.mergeAll(
		ReviewStore.layer,
		SettingsStore.layer,
		Layer.succeed(GitHub, github),
		Layer.succeed(PrIndex, index),
	).pipe(
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

const withDataDir = async <T>(fn: (dataDir: string) => Promise<T>) => {
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-repositories-data-"));
	try {
		return await fn(dataDir);
	} finally {
		await rm(dataDir, { recursive: true, force: true });
	}
};

const resolved = (state: "open" | "merged" | "closed") => ({
	kind: "resolved" as const,
	state,
});

const session = (
	owner: string,
	repo: string,
	number: number,
	updatedAt: number,
) => ({
	id: `${owner}/${repo}#${number}`,
	owner,
	repo,
	number,
	title: `PR ${number}`,
	prState: null,
	updatedAt,
});

describe("collecting repositories", () => {
	test("joins recorded paths and sessions on case-insensitive owner/repo, keeping the path's spelling", () => {
		const collected = collectRepositories(
			[{ owner: "Acme", repo: "Widgets", path: "/code/widgets" }],
			[session("acme", "widgets", 1, 10), session("acme", "gadgets", 2, 20)],
		);

		expect(
			collected.map((entry) => [entry.owner, entry.repo, entry.path]),
		).toEqual([
			["Acme", "Widgets", "/code/widgets"],
			["acme", "gadgets", null],
		]);
		expect(collected[0]?.sessions).toHaveLength(1);
	});

	test("sorts by latest session activity, with session-less repositories last", () => {
		const sorted = sortByActivity(
			collectRepositories(
				[
					{ owner: "zed", repo: "idle", path: "/z" },
					{ owner: "amy", repo: "idle", path: "/a" },
				],
				[session("acme", "old", 1, 10), session("acme", "new", 2, 99)],
			),
		);

		expect(sorted.map((entry) => entry.repo)).toEqual([
			"new",
			"old",
			"idle",
			"idle",
		]);
		expect(sorted.map((entry) => entry.owner).slice(2)).toEqual(["amy", "zed"]);
	});
});

describe("listRepositories", () => {
	test("reports each repository's checkout problem and open count without touching GitHub", async () => {
		const good = await makeCheckout("https://github.com/acme/widgets.git");
		const mismatched = await makeCheckout("https://github.com/acme/other.git");
		const noOrigin = await makeCheckout(null);
		try {
			await withDataDir(async (dataDir) => {
				const rows = await Effect.runPromise(
					Effect.gen(function* () {
						const settings = yield* SettingsStore;
						const reviews = yield* ReviewStore;
						yield* settings.setRepoPath("acme", "widgets", good);
						yield* settings.setRepoPath("acme", "gadgets", mismatched);
						yield* settings.setRepoPath("acme", "bare", noOrigin);
						yield* settings.setRepoPath("acme", "gone", `${good}-missing`);
						for (const number of [1, 2, 3])
							yield* reviews.openSession({
								repoRoot: `/wt/${number}`,
								baseRef: "main",
								headRef: `f${number}`,
								pr: { owner: "acme", repo: "widgets", number, title: "t" },
							});
						yield* reviews.openSession({
							repoRoot: "/wt/s",
							baseRef: "main",
							headRef: "s",
							pr: {
								owner: "acme",
								repo: "sessions-only",
								number: 9,
								title: "t",
							},
						});
						yield* reviews.openSession({
							repoRoot: "/wt/branch",
							baseRef: "main",
							headRef: "b",
							pr: null,
						});
						return yield* listRepositories;
					}).pipe(
						Effect.provide(
							makeLayer(dataDir, githubWith(), indexWithOpen([2, 3])),
						),
					),
				);

				expect(
					rows.map((row) => [
						row.repo,
						row.problem,
						row.openCount,
						row.sessionCount,
					]),
				).toEqual([
					["sessions-only", "no-path", 0, 1],
					["widgets", null, 2, 3],
					["bare", "no-origin", 0, 0],
					["gadgets", "origin-mismatch", 0, 0],
					["gone", "path-missing", 0, 0],
				]);
			});
		} finally {
			for (const dir of [good, mismatched, noOrigin])
				await rm(dir, { recursive: true, force: true });
		}
	});
});

const seedPullRequests = Effect.gen(function* () {
	const reviews = yield* ReviewStore;
	const opened = [];
	for (const number of [1, 2, 3, 4]) {
		opened.push(
			yield* reviews.openSession({
				repoRoot: `/wt/${number}`,
				baseRef: "main",
				headRef: `f${number}`,
				pr: { owner: "acme", repo: "widgets", number, title: `PR ${number}` },
			}),
		);
	}
	return opened;
});

const pending = { kind: "pending" } as const;

describe("getRepository", () => {
	test("reports open per the index and persisted terminal states, and leaves the rest pending without asking GitHub", async () => {
		const checkout = await makeCheckout("git@github.com:acme/widgets.git");
		try {
			await withDataDir(async (dataDir) => {
				const layer = makeLayer(dataDir, githubWith(), indexWithOpen([1]));
				const detail = await Effect.runPromise(
					Effect.gen(function* () {
						const settings = yield* SettingsStore;
						const reviews = yield* ReviewStore;
						yield* settings.setRepoPath("acme", "widgets", checkout);
						const opened = yield* seedPullRequests;
						const closed = opened[1];
						if (closed === undefined) return yield* Effect.die("seed");
						yield* reviews.setPrState(closed.id, "closed");
						return yield* getRepository("acme", "widgets");
					}).pipe(Effect.provide(layer)),
				);

				expect(
					detail.sessions.map((entry) => [entry.prNumber, entry.state]),
				).toEqual([
					[4, pending],
					[3, pending],
					[2, resolved("closed")],
					[1, resolved("open")],
				]);
				expect(detail).toMatchObject({
					path: checkout,
					remoteUrl: "git@github.com:acme/widgets.git",
					problem: null,
				});
			});
		} finally {
			await rm(checkout, { recursive: true, force: true });
		}
	});

	test("a persisted open is stale, so the session stays pending", async () => {
		await withDataDir(async (dataDir) => {
			const states = await Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					const [first] = yield* seedPullRequests;
					if (first === undefined) return yield* Effect.die("seed");
					yield* reviews.setPrState(first.id, "open");
					const detail = yield* getRepository("acme", "widgets");
					return detail.sessions.map((entry) => entry.state);
				}).pipe(
					Effect.provide(makeLayer(dataDir, githubWith(), indexWithOpen([]))),
				),
			);

			expect(states).toEqual([pending, pending, pending, pending]);
		});
	});

	test("a repository with no recorded path reports no-path and no remote", async () => {
		await withDataDir(async (dataDir) => {
			const detail = await Effect.runPromise(
				Effect.gen(function* () {
					yield* seedPullRequests;
					return yield* getRepository("acme", "widgets");
				}).pipe(
					Effect.provide(makeLayer(dataDir, githubWith(), indexWithOpen([]))),
				),
			);

			expect(detail).toMatchObject({
				path: null,
				remoteUrl: null,
				problem: "no-path",
			});
		});
	});
});

describe("streamSessionStates", () => {
	type Call = "list" | `view ${number}`;

	/** Runs the stream to completion, recording each GitHub call and, per event, what was already persisted when it arrived. */
	const run = async (
		github: GitHubShape,
		options: {
			openNumbers?: ReadonlyArray<number>;
			arrange?: Effect.Effect<void, unknown, ReviewStore>;
		} = {},
	) =>
		await withDataDir((dataDir) =>
			Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					yield* seedPullRequests;
					if (options.arrange !== undefined) yield* options.arrange;
					const events = yield* streamSessionStates("acme", "widgets").pipe(
						Stream.mapEffect((batch) =>
							reviews
								.listPullRequestSessions({ owner: "acme", repo: "widgets" })
								.pipe(
									Effect.map((stored) => ({
										batch,
										persisted: Object.fromEntries(
											stored.map((record) => [record.number, record.prState]),
										),
									})),
								),
						),
						Stream.runCollect,
					);
					const stored = yield* reviews.listPullRequestSessions({
						owner: "acme",
						repo: "widgets",
					});
					return {
						events,
						storedPairs: stored.map((record) => [
							record.number,
							record.prState,
						]),
						stored: Object.fromEntries(
							stored.map((record) => [record.number, record.prState]),
						),
					};
				}).pipe(
					Effect.provide(
						makeLayer(
							dataDir,
							github,
							indexWithOpen(options.openNumbers ?? []),
						),
					),
				),
			),
		);

	const recording = (
		calls: Call[],
		handlers: {
			list: GitHubShape["pullRequestStates"];
			view?: GitHubShape["pullRequestState"];
		},
	) =>
		githubWith({
			pullRequestStates: (...args) => {
				calls.push("list");
				return handlers.list(...args);
			},
			pullRequestState: (cwd, owner, repo, number) => {
				calls.push(`view ${number}`);
				return handlers.view === undefined
					? Effect.die(new Error("unexpected per-PR lookup"))
					: handlers.view(cwd, owner, repo, number);
			},
		});

	test("persists the whole listing, then yields it as a single event of the pending PRs only", async () => {
		const calls: Call[] = [];
		const result = await run(
			recording(calls, {
				list: () =>
					Effect.succeed([
						{ number: 4, state: "MERGED" as const },
						{ number: 3, state: "CLOSED" as const },
						{ number: 2, state: "OPEN" as const },
						{ number: 1, state: "OPEN" as const },
						{ number: 99, state: "MERGED" as const },
					]),
			}),
			{ openNumbers: [1] },
		);

		expect(calls).toEqual(["list"]);
		expect(result.events.map((entry) => entry.batch)).toEqual([
			[
				{ prNumber: 4, state: resolved("merged") },
				{ prNumber: 3, state: resolved("closed") },
				{ prNumber: 2, state: resolved("open") },
			],
		]);
		expect(result.stored).toEqual({
			1: null,
			2: "open",
			3: "closed",
			4: "merged",
		});
	});

	test("persists each state before yielding it", async () => {
		const result = await run(
			recording([], {
				list: () => Effect.succeed([{ number: 4, state: "MERGED" as const }]),
				view: () => Effect.succeed("CLOSED" as const),
			}),
		);

		expect(result.events).toHaveLength(4);
		for (const entry of result.events)
			for (const update of entry.batch) {
				expect(update.state.kind).toBe("resolved");
				if (update.state.kind === "resolved")
					expect(entry.persisted[update.prNumber]).toBe(update.state.state);
			}
	});

	test("looks up one by one only what the listing didn't return, and yields each as it lands", async () => {
		const calls: Call[] = [];
		const result = await run(
			recording(calls, {
				list: () => Effect.succeed([{ number: 3, state: "MERGED" as const }]),
				view: (_cwd, _owner, _repo, number) =>
					Effect.succeed(
						number === 2 ? ("OPEN" as const) : ("CLOSED" as const),
					),
			}),
		);

		expect(calls.slice().sort()).toEqual([
			"list",
			"view 1",
			"view 2",
			"view 4",
		]);
		expect(calls[0]).toBe("list");
		expect(result.events[0]?.batch).toEqual([
			{ prNumber: 3, state: resolved("merged") },
		]);
		expect(result.events.slice(1).map((entry) => entry.batch.length)).toEqual([
			1, 1, 1,
		]);
		expect(result.stored).toEqual({
			1: "closed",
			2: "open",
			3: "merged",
			4: "closed",
		});
	});

	test("a failed lookup is yielded unresolved and persists nothing for it", async () => {
		const result = await run(
			recording([], {
				list: () => Effect.succeed([]),
				view: (_cwd, _owner, _repo, number) =>
					number === 3
						? Effect.fail(
								new PullRequestNotFound({
									repoRoot: "/",
									number,
									reason: "boom",
								}),
							)
						: Effect.succeed("MERGED" as const),
			}),
		);

		const updates = result.events.flatMap((entry) => entry.batch);
		expect(updates).toHaveLength(4);
		expect(updates.find((update) => update.prNumber === 3)?.state).toEqual({
			kind: "unresolved",
			reason: "boom",
		});
		expect(result.stored).toEqual({
			1: "merged",
			2: "merged",
			3: null,
			4: "merged",
		});
	});

	test("a listing that fails for a reason particular to it falls back to per-PR lookups for everything", async () => {
		const calls: Call[] = [];
		const result = await run(
			recording(calls, {
				list: () =>
					Effect.fail(new GitHubUnreachable({ repoRoot: "/", reason: "dns" })),
				view: () => Effect.succeed("MERGED" as const),
			}),
		);

		expect(calls.slice().sort()).toEqual([
			"list",
			"view 1",
			"view 2",
			"view 3",
			"view 4",
		]);
		expect(result.stored).toEqual({
			1: "merged",
			2: "merged",
			3: "merged",
			4: "merged",
		});
	});

	test("an authentication failure is reported for every pending PR at once, without a lookup each", async () => {
		const calls: Call[] = [];
		const result = await run(
			recording(calls, {
				list: () => Effect.fail(new GhNotAuthenticated({ reason: "log in" })),
			}),
			{ openNumbers: [1] },
		);

		expect(calls).toEqual(["list"]);
		expect(result.events).toHaveLength(1);
		expect(result.events[0]?.batch).toEqual(
			[4, 3, 2].map((prNumber) => ({
				prNumber,
				state: {
					kind: "unresolved",
					reason: "gh is not authenticated: log in",
				},
			})),
		);
		expect(result.stored).toEqual({ 1: null, 2: null, 3: null, 4: null });
	});

	test("with nothing pending it yields nothing and never asks GitHub", async () => {
		const calls: Call[] = [];
		const result = await run(
			recording(calls, { list: () => Effect.succeed([]) }),
			{
				openNumbers: [1, 2, 3, 4],
			},
		);

		expect(calls).toEqual([]);
		expect(result.events).toEqual([]);
	});

	test("every session of a reused PR number gets the state", async () => {
		const result = await run(
			recording([], {
				list: () => Effect.succeed([{ number: 3, state: "MERGED" as const }]),
				view: () => Effect.succeed("CLOSED" as const),
			}),
			{
				arrange: Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					yield* reviews.openSession({
						repoRoot: "/wt/again",
						baseRef: "main",
						headRef: "again",
						pr: { owner: "acme", repo: "widgets", number: 3, title: "PR 3" },
					});
				}),
			},
		);

		expect(result.storedPairs.filter(([number]) => number === 3)).toEqual([
			[3, "merged"],
			[3, "merged"],
		]);
	});
});
