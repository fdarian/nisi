import {
	GitHub,
	type OpenPullRequestIndex,
	type OpenPullRequestIndexOptions,
	readIndexHead,
} from "@repo/git";
import { SettingsStore } from "@repo/settings";
import type { IndexedPullRequests } from "@repo/sidecar-api";
import {
	Context,
	Deferred,
	Effect,
	Fiber,
	Layer,
	Schedule,
	Scope,
} from "effect";
import { emit } from "./events.ts";

export const makePrIndex = <E, R>(
	fetch: (
		path: string,
		owner: string,
		repo: string,
		options?: OpenPullRequestIndexOptions,
	) => Effect.Effect<OpenPullRequestIndex, E, R>,
	now = Date.now,
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const entries = new Map<string, OpenPullRequestIndex>();
		const pending = new Map<string, Fiber.Fiber<void>>();
		const completed = new Map<
			string,
			{ highWaterMark?: string; fullAt: number }
		>();
		const merge = (
			previous: OpenPullRequestIndex | undefined,
			current: OpenPullRequestIndex,
		): OpenPullRequestIndex => {
			if (previous === undefined) return current;
			const numbers = new Set([
				...current.prs.map((pr) => pr.number),
				...(current.removedNumbers ?? []),
			]);
			return {
				...current,
				prs: [
					...current.prs,
					...previous.prs.filter((pr) => !numbers.has(pr.number)),
				],
			};
		};
		const key = (owner: string, repo: string) =>
			`${owner.toLowerCase()}/${repo.toLowerCase()}`;
		// Uninterruptible so a caller can't be interrupted between forking the
		// refresh and recording it as pending. An already-running refresh is
		// returned as is, so callers can await it.
		const refresh = (path: string, owner: string, repo: string) =>
			Effect.gen(function* () {
				const id = key(owner, repo);
				const running = pending.get(id);
				if (running !== undefined) return running;
				const previous = entries.get(id);
				const last = completed.get(id);
				const full =
					last?.highWaterMark === undefined ||
					now() - last.fullAt >= 30 * 60_000;
				const pages: OpenPullRequestIndex["prs"][number][] = [];
				const removed = new Set<number>();
				const seen = new Set<number>();
				const fiber = yield* fetch(path, owner, repo, {
					...(full ? {} : { updatedSince: last.highWaterMark }),
					onPage: (page) =>
						Effect.gen(function* () {
							for (const number of page.removedNumbers ?? [])
								removed.add(number);
							for (const pr of page.prs)
								if (!seen.has(pr.number)) {
									seen.add(pr.number);
									pages.push(pr);
								}
							entries.set(
								id,
								merge(previous, {
									...page,
									prs: [...pages],
									removedNumbers: [...removed],
								}),
							);
							yield* Effect.logInfo("PR index page published", {
								repository: id,
								count: pages.length,
								full,
							});
						}),
				}).pipe(
					Effect.tap((value) =>
						Effect.sync(() => {
							entries.set(id, full ? value : merge(previous, value));
							completed.set(id, {
								...(value.highWaterMark === undefined
									? {}
									: { highWaterMark: value.highWaterMark }),
								fullAt: full ? now() : last.fullAt,
							});
							if (
								full ||
								value.prs.length > 0 ||
								(value.removedNumbers?.length ?? 0) > 0
							)
								emit({ type: "pull-request-index-changed" });
						}),
					),
					Effect.tap((value) =>
						Effect.logInfo("PR index refreshed", {
							repository: id,
							count: value.prs.length,
						}),
					),
					Effect.catchCause((cause) =>
						Effect.logWarning("PR index refresh failed; retaining last index", {
							repository: id,
							cause,
						}),
					),
					Effect.asVoid,
					Effect.ensuring(Effect.sync(() => pending.delete(id))),
					Effect.withSpan("pr-index.refresh", {
						root: true,
						attributes: { repository: id },
					}),
					Effect.forkIn(scope),
				);
				// A fiber that already finished has already run its `ensuring`.
				if (fiber.pollUnsafe() === undefined) pending.set(id, fiber);
				return fiber;
			}).pipe(Effect.uninterruptible);
		return {
			refresh,
			empty: () => entries.size === 0,
			indexed: (
				known: readonly { readonly owner: string; readonly repo: string }[],
			): IndexedPullRequests => ({
				rows: [...entries]
					.filter(([id]) => completed.has(id))
					.flatMap(([, entry]) =>
						entry.prs.flatMap((pr) =>
							pr.state === "OPEN"
								? [
										{
											owner: entry.repository.owner,
											repo: entry.repository.repo,
											number: pr.number,
											title: pr.title,
											author: pr.author,
											updatedAt: pr.updatedAt,
											url: pr.url,
											isDraft: pr.isDraft,
											state: pr.state,
											headRefName: pr.headRef,
										},
									]
								: [],
						),
					),
				incompleteRepos: [
					...new Set(known.map((repo) => key(repo.owner, repo.repo))),
				].filter((id) => !completed.has(id)),
			}),
			findNumber: (owner: string, repo: string, number: number) => {
				const entry = entries.get(key(owner, repo));
				const pr = entry?.prs.find((candidate) => candidate.number === number);
				return entry === undefined || pr === undefined
					? undefined
					: { repository: entry.repository, pr };
			},
			find: (
				owner: string,
				repo: string,
				headOwner: string,
				branch: string,
			) => {
				const entry = entries.get(key(owner, repo));
				const pr = entry?.prs.find(
					(candidate) =>
						candidate.headOwner?.toLowerCase() === headOwner.toLowerCase() &&
						candidate.headRef === branch,
				);
				return pr === undefined || entry === undefined
					? undefined
					: { repository: entry.repository, pr };
			},
		};
	});

// `ready` stops waiting for the boot refreshes after this long, so one hung
// `gh` can't hold the palette's first index load forever.
const BOOT_WAIT = "60 seconds";

export const makePrIndexMaintenance = <E, R>(
	refresh: Effect.Effect<readonly Fiber.Fiber<unknown>[], E, R>,
	schedule = Schedule.spaced("5 minutes"),
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const ready = yield* Deferred.make<void>();
		const iteration = refresh.pipe(
			Effect.catchCause((cause) =>
				Effect.logWarning("Could not refresh known PR index repositories", {
					cause,
				}).pipe(Effect.as([])),
			),
		);
		let booted = false;
		// Only the boot pass gates `ready`, and it does so from its own fiber:
		// waiting inline would stall the schedule behind a slow `gh`.
		const tick = Effect.gen(function* () {
			const fibers = yield* iteration;
			if (booted) return;
			booted = true;
			yield* Effect.forEach(fibers, Fiber.await, { discard: true }).pipe(
				Effect.race(Effect.sleep(BOOT_WAIT)),
				Effect.andThen(Deferred.succeed(ready, undefined)),
				Effect.forkIn(scope),
			);
		});
		return {
			ready: Deferred.await(ready),
			refreshKnown: iteration.pipe(Effect.forkIn(scope), Effect.asVoid),
			start: tick.pipe(Effect.repeat(schedule)),
		};
	});

export class PrIndex extends Context.Service<PrIndex>()("sidecar/PrIndex", {
	make: Effect.gen(function* () {
		const github = yield* GitHub;
		const settings = yield* SettingsStore;
		const index = yield* makePrIndex(github.listOpenPullRequests);
		const refreshKnown = Effect.gen(function* () {
			const paths = yield* settings.listRepoPaths();
			const fibers: Fiber.Fiber<void>[] = [];
			for (const path of paths)
				fibers.push(yield* index.refresh(path.path, path.owner, path.repo));
			return fibers;
		});
		const lookup = (repoRoot: string) =>
			Effect.gen(function* () {
				if (index.empty()) {
					yield* Effect.annotateCurrentSpan("hit", false);
					return undefined;
				}
				const head = yield* readIndexHead(repoRoot);
				const found =
					head === undefined
						? undefined
						: index.find(head.owner, head.repo, head.headOwner, head.branch);
				yield* Effect.annotateCurrentSpan("hit", found !== undefined);
				return found;
			}).pipe(Effect.withSpan("session.pr-index.lookup"));
		const maintenance = yield* makePrIndexMaintenance(refreshKnown);
		const lookupPullRequest = (owner: string, repo: string, number: number) =>
			Effect.gen(function* () {
				const found = index.findNumber(owner, repo, number);
				yield* Effect.annotateCurrentSpan("hit", found !== undefined);
				return found;
			}).pipe(Effect.withSpan("pull-request.pr-index.lookup"));
		return {
			lookup,
			lookupPullRequest,
			indexed: Effect.gen(function* () {
				yield* maintenance.ready;
				return index.indexed(yield* settings.listRepoPaths());
			}),
			refresh: index.refresh,
			refreshKnown: maintenance.refreshKnown,
			start: maintenance.start,
		};
	}),
}) {
	static readonly layer = Layer.effect(PrIndex, PrIndex.make);
}
