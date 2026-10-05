import {
	GitHub,
	type OpenPullRequestIndex,
	type OpenPullRequestIndexOptions,
	readIndexHead,
} from "@repo/git";
import { SettingsStore } from "@repo/settings";
import { Context, Effect, Layer, Schedule, Scope } from "effect";

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
		const pending = new Set<string>();
		const completed = new Map<
			string,
			{ highWaterMark?: string; fullAt: number }
		>();
		const merge = (
			previous: OpenPullRequestIndex | undefined,
			current: OpenPullRequestIndex,
		): OpenPullRequestIndex => {
			if (previous === undefined) return current;
			const numbers = new Set(current.prs.map((pr) => pr.number));
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
		const refresh = (path: string, owner: string, repo: string) =>
			Effect.gen(function* () {
				const id = key(owner, repo);
				if (pending.has(id)) return;
				pending.add(id);
				const previous = entries.get(id);
				const last = completed.get(id);
				const full =
					last?.highWaterMark === undefined ||
					now() - last.fullAt >= 30 * 60_000;
				const pages: OpenPullRequestIndex["prs"][number][] = [];
				const seen = new Set<number>();
				return yield* fetch(path, owner, repo, {
					...(full ? {} : { updatedSince: last.highWaterMark }),
					onPage: (page) =>
						Effect.gen(function* () {
							for (const pr of page.prs)
								if (!seen.has(pr.number)) {
									seen.add(pr.number);
									pages.push(pr);
								}
							entries.set(id, merge(previous, { ...page, prs: [...pages] }));
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
					Effect.ensuring(Effect.sync(() => pending.delete(id))),
					Effect.withSpan("pr-index.refresh", {
						root: true,
						attributes: { repository: id },
					}),
					Effect.forkIn(scope),
				);
			});
		return {
			refresh,
			empty: () => entries.size === 0,
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
						candidate.headOwner === headOwner && candidate.headRef === branch,
				);
				return pr === undefined || entry === undefined
					? undefined
					: { repository: entry.repository, pr };
			},
		};
	});

export class PrIndex extends Context.Service<PrIndex>()("sidecar/PrIndex", {
	make: Effect.gen(function* () {
		const github = yield* GitHub;
		const settings = yield* SettingsStore;
		const index = yield* makePrIndex(github.listOpenPullRequests);
		const refreshKnown = Effect.gen(function* () {
			const paths = yield* settings.listRepoPaths();
			for (const path of paths)
				yield* index.refresh(path.path, path.owner, path.repo);
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
		const start = refreshKnown.pipe(
			Effect.repeat(Schedule.spaced("5 minutes")),
		);
		const lookupPullRequest = (owner: string, repo: string, number: number) =>
			Effect.gen(function* () {
				const found = index.findNumber(owner, repo, number);
				yield* Effect.annotateCurrentSpan("hit", found !== undefined);
				return found;
			}).pipe(Effect.withSpan("pull-request.pr-index.lookup"));
		return {
			lookup,
			lookupPullRequest,
			refresh: index.refresh,
			refreshKnown,
			start,
		};
	}),
}) {
	static readonly layer = Layer.effect(PrIndex, PrIndex.make);
}
