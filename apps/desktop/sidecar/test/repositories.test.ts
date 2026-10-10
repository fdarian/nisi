import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { GitHub, type GitHubShape, PullRequestNotFound } from "@repo/git";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
import { ConfigProvider, type Context, Effect, Layer, Stream } from "effect";
import { PrIndex } from "../pr-index.ts";
import {
	collectRepositories,
	getRepository,
	listRepositories,
	sortByActivity,
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
	pullRequestState: GitHubShape["pullRequestState"],
): GitHubShape => ({
	listOpenPullRequests: unused,
	getActionsJob: unused,
	getActionsJobLogs: unused,
	rerunActionsJob: unused,
	repository: unused,
	pullRequest: unused,
	pullRequestState,
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
							makeLayer(dataDir, githubWith(unused), indexWithOpen([2, 3])),
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

describe("getRepository", () => {
	const seed = Effect.gen(function* () {
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

	test("trusts the index and persisted terminal states, asks GitHub only for the rest, and remembers the answer", async () => {
		const checkout = await makeCheckout("git@github.com:acme/widgets.git");
		try {
			await withDataDir(async (dataDir) => {
				const asked: number[] = [];
				const github = githubWith((_cwd, _owner, _repo, number) => {
					asked.push(number);
					return Effect.succeed("MERGED" as const);
				});
				const layer = makeLayer(dataDir, github, indexWithOpen([1]));
				const detail = await Effect.runPromise(
					Effect.gen(function* () {
						const settings = yield* SettingsStore;
						const reviews = yield* ReviewStore;
						yield* settings.setRepoPath("acme", "widgets", checkout);
						const opened = yield* seed;
						const closed = opened[1];
						if (closed === undefined) return yield* Effect.die("seed");
						yield* reviews.setPrState(closed.id, "closed");
						const first = yield* getRepository("acme", "widgets");
						const second = yield* getRepository("acme", "widgets");
						return { first, second };
					}).pipe(Effect.provide(layer)),
				);

				expect(asked.sort()).toEqual([3, 4]);
				expect(
					detail.first.sessions.map((entry) => [entry.prNumber, entry.state]),
				).toEqual([
					[4, resolved("merged")],
					[3, resolved("merged")],
					[2, resolved("closed")],
					[1, resolved("open")],
				]);
				expect(detail.second.sessions.map((entry) => entry.state)).toEqual(
					detail.first.sessions.map((entry) => entry.state),
				);
				expect(detail.first).toMatchObject({
					path: checkout,
					remoteUrl: "git@github.com:acme/widgets.git",
					problem: null,
				});
			});
		} finally {
			await rm(checkout, { recursive: true, force: true });
		}
	});

	test("a persisted open is stale and gets re-asked", async () => {
		await withDataDir(async (dataDir) => {
			const github = githubWith(() => Effect.succeed("MERGED" as const));
			const states = await Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					const [first] = yield* seed;
					if (first === undefined) return yield* Effect.die("seed");
					yield* reviews.setPrState(first.id, "open");
					const detail = yield* getRepository("acme", "widgets");
					return detail.sessions.map((entry) => entry.state);
				}).pipe(Effect.provide(makeLayer(dataDir, github, indexWithOpen([])))),
			);

			expect(states).toEqual([
				resolved("merged"),
				resolved("merged"),
				resolved("merged"),
				resolved("merged"),
			]);
		});
	});

	test("one failed lookup leaves only that session unresolved and persists nothing for it", async () => {
		await withDataDir(async (dataDir) => {
			const github = githubWith((_cwd, _owner, _repo, number) =>
				number === 3
					? Effect.fail(
							new PullRequestNotFound({
								repoRoot: "/",
								number,
								reason: "boom",
							}),
						)
					: Effect.succeed("MERGED" as const),
			);
			const result = await Effect.runPromise(
				Effect.gen(function* () {
					const reviews = yield* ReviewStore;
					yield* seed;
					const detail = yield* getRepository("acme", "widgets");
					const stored = yield* reviews.listPullRequestSessions({
						owner: "acme",
						repo: "widgets",
					});
					return { detail, stored };
				}).pipe(Effect.provide(makeLayer(dataDir, github, indexWithOpen([])))),
			);

			expect(
				result.detail.sessions.map((entry) => [entry.prNumber, entry.state]),
			).toEqual([
				[4, resolved("merged")],
				[3, { kind: "unresolved", reason: "boom" }],
				[2, resolved("merged")],
				[1, resolved("merged")],
			]);
			expect(
				result.stored.map((record) => [record.number, record.prState]),
			).toEqual([
				[4, "merged"],
				[3, null],
				[2, "merged"],
				[1, "merged"],
			]);
		});
	});

	test("a repository with no recorded path reports no-path and no remote", async () => {
		await withDataDir(async (dataDir) => {
			const detail = await Effect.runPromise(
				Effect.gen(function* () {
					yield* seed;
					return yield* getRepository("acme", "widgets");
				}).pipe(
					Effect.provide(
						makeLayer(
							dataDir,
							githubWith(() => Effect.succeed("OPEN" as const)),
							indexWithOpen([]),
						),
					),
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
