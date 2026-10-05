import {
	prepareDiff,
	readLocalBase,
	resolveHeadSha,
	type PreparedDiff,
	type GitError,
} from "@repo/git";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";

export const makeDiffPreparation = () =>
	Effect.gen(function* () {
		const entries = new Map<
			string,
			{
				at: number;
				read: Effect.Effect<
					PreparedDiff,
					GitError,
					FileSystem | ChildProcessSpawner.ChildProcessSpawner
				>;
			}
		>();
		const read = (
			repoRoot: string,
			baseRef: string,
			options: { includeUncommitted: boolean; headRef?: string },
		) =>
			Effect.gen(function* () {
				const refs = yield* Effect.all(
					[
						readLocalBase(repoRoot, baseRef),
						resolveHeadSha(repoRoot, options.headRef),
					],
					{ concurrency: "unbounded" },
				);
				const baseCommit = refs[0].commit;
				const effect = prepareDiff(repoRoot, baseRef, {
					...options,
					...(baseCommit === null ? {} : { baseCommit }),
					headCommit: refs[1],
				});
				if (options.includeUncommitted) return yield* effect;
				const key = `${repoRoot}\n${refs[0].baseRef}\n${baseCommit}\n${refs[1]}`;
				const existing = entries.get(key);
				if (existing !== undefined && Date.now() - existing.at < 30_000) {
					yield* Effect.annotateCurrentSpan("reused", true);
					return yield* existing.read;
				}
				if (entries.size >= 8) {
					const oldest = entries.keys().next();
					if (!oldest.done) entries.delete(oldest.value);
				}
				const cached = yield* Effect.cached(
					effect.pipe(
						Effect.tapError(() => Effect.sync(() => entries.delete(key))),
					),
				);
				entries.set(key, { at: Date.now(), read: cached });
				return yield* cached;
			}).pipe(Effect.withSpan("diff.preparation.read"));
		return { read };
	});
