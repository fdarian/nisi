import { GitHub, readIndexHead, type OpenPullRequestIndex } from "@repo/git";
import { SettingsStore } from "@repo/settings";
import { Context, Effect, Layer, Schedule, Scope } from "effect";

export const makePrIndex = <E, R>(
	fetch: (
		path: string,
		owner: string,
		repo: string,
	) => Effect.Effect<OpenPullRequestIndex, E, R>,
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
		const entries = new Map<string, OpenPullRequestIndex>();
		const pending = new Set<string>();
		const key = (owner: string, repo: string) =>
			`${owner.toLowerCase()}/${repo.toLowerCase()}`;
		const refresh = (path: string, owner: string, repo: string) =>
			Effect.gen(function* () {
				const id = key(owner, repo);
				if (pending.has(id)) return;
				pending.add(id);
				return yield* fetch(path, owner, repo).pipe(
					Effect.tap((value) => Effect.sync(() => entries.set(id, value))),
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
		return { lookup, refresh: index.refresh, refreshKnown, start };
	}),
}) {
	static readonly layer = Layer.effect(PrIndex, PrIndex.make);
}
