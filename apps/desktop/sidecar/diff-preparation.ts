import {
	type GitError,
	type PreparedDiff,
	type WorktreeReadFailed,
	prepareDiff,
	readLocalBase,
	readRepoChangeSignature,
	resolveHeadSha,
} from "@repo/git";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { readRefState } from "./ref-state.ts";

export const makeDiffPreparation = () =>
	Effect.gen(function* () {
		const bases = new Map<
			string,
			{ state: string; value: { baseRef: string; commit: string | null } }
		>();
		const resolveBase = (
			repoRoot: string,
			baseRef: string,
			state: string | undefined,
		) =>
			Effect.gen(function* () {
				const key = `${repoRoot}\n${baseRef}`;
				const previous = bases.get(key);
				if (state !== undefined && previous?.state === state) {
					yield* Effect.annotateCurrentSpan("reused", true);
					return previous.value;
				}
				const value = yield* readLocalBase(repoRoot, baseRef);
				if (
					state !== undefined &&
					state === (yield* readRefState(repoRoot, baseRef))
				) {
					if (bases.size >= 8) {
						const oldest = bases.keys().next();
						if (!oldest.done) bases.delete(oldest.value);
					}
					bases.set(key, { state, value });
				}
				return value;
			}).pipe(Effect.withSpan("diff.base.resolve"));
		const localBase = (repoRoot: string, baseRef: string) =>
			Effect.gen(function* () {
				return yield* resolveBase(
					repoRoot,
					baseRef,
					yield* readRefState(repoRoot, baseRef),
				);
			});
		const entries = new Map<
			string,
			{
				at: number;
				read: Effect.Effect<
					PreparedDiff,
					GitError | WorktreeReadFailed,
					FileSystem | ChildProcessSpawner.ChildProcessSpawner
				>;
			}
		>();
		const validated = new Map<
			string,
			{
				state: string;
				read: Effect.Effect<
					PreparedDiff,
					GitError | WorktreeReadFailed,
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
				const worktree =
					options.includeUncommitted && options.headRef === undefined;
				const validationKey = `${repoRoot}\n${baseRef}\n${options.headRef ?? "HEAD"}\n${worktree}`;
				const validationState = Effect.gen(function* () {
					const refs = yield* readRefState(repoRoot, baseRef, options.headRef);
					if (refs === undefined || !worktree) return refs;
					const signature = yield* readRepoChangeSignature(repoRoot, {
						includeUncommitted: true,
					});
					if (signature.complete === false) return undefined;
					return `${refs}\n${JSON.stringify([signature.headSha, signature.status, [...signature.files].sort((a, b) => a[0].localeCompare(b[0]))])}`;
				});
				const state = yield* validationState;
				const previous = validated.get(validationKey);
				if (state !== undefined && previous?.state === state) {
					yield* Effect.annotateCurrentSpan("refsReused", true);
					return yield* previous.read;
				}
				const refs = yield* Effect.all(
					[
						options.headRef === undefined && !worktree
							? resolveBase(repoRoot, baseRef, state)
							: localBase(repoRoot, baseRef),
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
				if (worktree && state === undefined) return yield* effect;
				const key = `${repoRoot}\n${refs[0].baseRef}\n${baseCommit}\n${refs[1]}\n${worktree ? state : "committed"}`;
				const existing = entries.get(key);
				if (existing !== undefined && Date.now() - existing.at < 30_000) {
					yield* Effect.annotateCurrentSpan("reused", true);
					return yield* existing.read;
				}
				if (entries.size >= 8) {
					const oldest = entries.keys().next();
					if (!oldest.done) entries.delete(oldest.value);
				}
				const cached: Effect.Effect<
					PreparedDiff,
					GitError | WorktreeReadFailed,
					FileSystem | ChildProcessSpawner.ChildProcessSpawner
				> = yield* Effect.cached(
					effect.pipe(
						Effect.tap(() =>
							Effect.gen(function* () {
								if (state !== undefined && state === (yield* validationState)) {
									if (validated.size >= 8) {
										const oldest = validated.keys().next();
										if (!oldest.done) validated.delete(oldest.value);
									}
									validated.set(validationKey, { state, read: cached });
								} else if (worktree) entries.delete(key);
							}),
						),
						Effect.tapError(() =>
							Effect.sync(() => {
								entries.delete(key);
								validated.delete(validationKey);
							}),
						),
					),
				);
				entries.set(key, { at: Date.now(), read: cached });
				return yield* cached;
			}).pipe(Effect.withSpan("diff.preparation.read"));
		return { read, localBase };
	});
