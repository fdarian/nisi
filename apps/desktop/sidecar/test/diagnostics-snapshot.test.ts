import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { SqliteDb } from "@repo/db";
import { ReviewStore } from "@repo/review";
import type { PullRequestMergeStatus } from "@repo/sidecar-api";
import { ConfigProvider, Effect, Layer } from "effect";
import { buildDiagnosticsSnapshot } from "../diagnostics-snapshot.ts";
import { MergeStatusLedger } from "../merge-status-ledger.ts";
import { AttentionState } from "../pull-request-attention.ts";
import { RpcFailureLedger } from "../rpc-failure-ledger.ts";

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
	return (await new Response(proc.stdout).text()).trim();
};

const makeTestRepo = async () => {
	const root = await mkdtemp(join(tmpdir(), "nisi-diagnostics-repo-"));
	await sh(root, ["init", "-q", "-b", "main"]);
	await sh(root, ["config", "user.email", "test@example.com"]);
	await sh(root, ["config", "user.name", "Test"]);
	await Bun.write(join(root, "a.ts"), "hello\n");
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", "base"]);
	return root;
};

const withFixtures = async <T>(
	fn: (repoRoot: string, dataDir: string) => Promise<T>,
) => {
	const repoRoot = await makeTestRepo();
	const dataDir = await mkdtemp(join(tmpdir(), "nisi-diagnostics-data-"));
	try {
		return await fn(repoRoot, dataDir);
	} finally {
		await rm(repoRoot, { recursive: true, force: true });
		await rm(dataDir, { recursive: true, force: true });
	}
};

const makeLayer = (dataDir: string) =>
	Layer.mergeAll(
		ReviewStore.layer,
		AttentionState.layer,
		MergeStatusLedger.layer,
		RpcFailureLedger.layer,
	).pipe(
		Layer.provideMerge(SqliteDb.layer),
		Layer.provideMerge(BunServices.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({ NISI_DATA_DIR: dataDir }),
			),
		),
	);

const pullRequest = { owner: "acme", repo: "widgets", number: 7 };

const mergeStatus = (
	mergeable: PullRequestMergeStatus["mergeable"],
	state: PullRequestMergeStatus["state"] = "OPEN",
): PullRequestMergeStatus => ({
	state,
	mergeable,
	mergeStateStatus: "CLEAN",
	isDraft: false,
	allowedMethods: ["squash"],
	defaultMethod: "squash",
});

test("reports a deleted repoRoot instead of failing the whole snapshot", () =>
	withFixtures(async (repoRoot, dataDir) => {
		const gone = join(dataDir, "deleted-worktree");
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* ReviewStore;
				const dead = yield* store.openSession({
					repoRoot: gone,
					baseRef: "main",
					headRef: "feature",
					pr: { ...pullRequest, title: "Dead" },
				});
				yield* store.openSession({
					repoRoot,
					baseRef: "main",
					headRef: "main",
					pr: null,
				});
				const snapshot = yield* buildDiagnosticsSnapshot({});
				expect(snapshot.sessions).toHaveLength(2);
				const deadEntry = snapshot.sessions.find(
					(session) => session.sessionId === dead.id,
				);
				expect(deadEntry).toMatchObject({
					repoRoot: gone,
					repoRootExists: false,
					worktreeHead: null,
					worktreeHeadError: null,
					headRefSha: null,
					pr: pullRequest,
				});
			}).pipe(Effect.provide(makeLayer(dataDir))),
		);
	}));

test("reads the live worktree HEAD and the stored head ref", () =>
	withFixtures(async (repoRoot, dataDir) => {
		const head = await sh(repoRoot, ["rev-parse", "HEAD"]);
		await sh(repoRoot, ["branch", "other"]);
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* ReviewStore;
				const session = yield* store.openSession({
					repoRoot,
					baseRef: "main",
					headRef: "main",
					pr: null,
				});
				const first = (yield* buildDiagnosticsSnapshot({})).sessions[0];
				expect(first).toMatchObject({
					sessionId: session.id,
					repoRootExists: true,
					worktreeHead: head,
					worktreeHeadError: null,
					headRef: "main",
					headRefSha: head,
					pr: null,
					watched: false,
					mergeStatus: null,
				});

				// The checkout moved on to a different commit than the stored head ref.
				yield* Effect.promise(async () => {
					await sh(repoRoot, ["checkout", "-q", "other"]);
					await sh(repoRoot, ["commit", "-q", "--allow-empty", "-m", "moved"]);
				});
				const moved = (yield* buildDiagnosticsSnapshot({})).sessions[0];
				expect(moved?.worktreeHead).not.toBe(head);
				expect(moved?.headRefSha).toBe(head);
			}).pipe(Effect.provide(makeLayer(dataDir))),
		);
	}));

test("surfaces git's failure when repoRoot exists but is not a repository", () =>
	withFixtures(async (_repoRoot, dataDir) => {
		const plain = await mkdtemp(join(tmpdir(), "nisi-diagnostics-plain-"));
		try {
			await Effect.runPromise(
				Effect.gen(function* () {
					const store = yield* ReviewStore;
					yield* store.openSession({
						repoRoot: plain,
						baseRef: "main",
						headRef: "main",
						pr: null,
					});
					const entry = (yield* buildDiagnosticsSnapshot({})).sessions[0];
					expect(entry?.repoRootExists).toBe(true);
					expect(entry?.worktreeHead).toBeNull();
					expect(entry?.worktreeHeadError).toContain("not a git repository");
				}).pipe(Effect.provide(makeLayer(dataDir))),
			);
		} finally {
			await rm(plain, { recursive: true, force: true });
		}
	}));

test("watched and pollScheduled follow attention, not just the last status", () =>
	withFixtures(async (repoRoot, dataDir) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* ReviewStore;
				const attention = yield* AttentionState;
				const ledger = yield* MergeStatusLedger;
				const opened = yield* store.openSession({
					repoRoot,
					baseRef: "main",
					headRef: "main",
					pr: { ...pullRequest, title: "Seven" },
				});
				const wire = {
					id: opened.id,
					repoRoot,
					target: {
						kind: "pr",
						...pullRequest,
						title: "Seven",
						baseRef: "main",
						headRef: "main",
					},
				} as const;
				const only = () =>
					buildDiagnosticsSnapshot({ sessionId: opened.id }).pipe(
						Effect.map((snapshot) => snapshot.sessions[0]),
					);

				expect((yield* only())?.mergeStatus).toBeNull();

				yield* ledger.record(pullRequest, mergeStatus("MERGEABLE"));
				const unwatched = yield* only();
				expect(unwatched?.watched).toBe(false);
				expect(unwatched?.mergeStatus).toMatchObject({
					status: { mergeable: "MERGEABLE" },
					// Unwatched open PRs are still re-read at the slow baseline.
					pollScheduled: true,
				});

				yield* attention.set(wire, true);
				const watched = yield* only();
				expect(watched?.watched).toBe(true);
				expect(watched?.mergeStatus?.pollScheduled).toBe(true);

				// GitHub still computing mergeability is re-polled even when unwatched.
				yield* attention.set(wire, false);
				yield* ledger.record(pullRequest, mergeStatus("UNKNOWN"));
				expect((yield* only())?.mergeStatus?.pollScheduled).toBe(true);

				// A merged PR is settled: nothing is polled, watched or not.
				yield* ledger.record(pullRequest, mergeStatus("MERGEABLE", "MERGED"));
				expect((yield* only())?.mergeStatus?.pollScheduled).toBe(false);
				yield* attention.set(wire, true);
				expect((yield* only())?.mergeStatus?.pollScheduled).toBe(false);
			}).pipe(Effect.provide(makeLayer(dataDir))),
		);
	}));

test("filters by sessionId, fails for an unknown one, and always lists rpc failures", () =>
	withFixtures(async (repoRoot, dataDir) => {
		await Effect.runPromise(
			Effect.gen(function* () {
				const store = yield* ReviewStore;
				const failures = yield* RpcFailureLedger;
				const wanted = yield* store.openSession({
					repoRoot,
					baseRef: "main",
					headRef: "main",
					pr: null,
				});
				yield* store.openSession({
					repoRoot,
					baseRef: "main",
					headRef: "other",
					pr: null,
				});
				yield* failures.record(["sessions", "setAttention"], new Error("boom"));

				const filtered = yield* buildDiagnosticsSnapshot({
					sessionId: wanted.id,
				});
				expect(filtered.sessions.map((session) => session.sessionId)).toEqual([
					wanted.id,
				]);
				expect(filtered.rpcFailures).toMatchObject([
					{ path: "sessions.setAttention", errorTag: "Error", count: 1 },
				]);

				const missing = yield* buildDiagnosticsSnapshot({
					sessionId: "nope",
				}).pipe(Effect.flip);
				expect(missing._tag).toBe("SessionNotFound");
			}).pipe(Effect.provide(makeLayer(dataDir))),
		);
	}));
