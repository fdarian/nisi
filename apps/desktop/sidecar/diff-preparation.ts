import {
	type GitError,
	type PreparedDiff,
	prepareDiff,
	readLocalBase,
	readRepoChangeSignature,
	resolveHeadSha,
	type WorktreeReadFailed,
} from "@repo/git";
import { Effect, Exit, Fiber, Scope } from "effect";
import { readRefState } from "./ref-state.ts";

type SharedPreparation = Fiber.Fiber<
	PreparedDiff,
	GitError | WorktreeReadFailed
>;

export const makeDiffPreparation = (
	prepare: typeof prepareDiff = prepareDiff,
) =>
	Effect.gen(function* () {
		const scope = yield* Scope.Scope;
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
		const entries = new Map<string, { at: number; fiber: SharedPreparation }>();
		const validated = new Map<
			string,
			{ state: string; fiber: SharedPreparation }
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
					return yield* Fiber.join(previous.fiber);
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
				const effect = prepare(repoRoot, baseRef, {
					...options,
					...(baseCommit === null ? {} : { baseCommit }),
					headCommit: refs[1],
				});
				if (worktree && state === undefined) return yield* effect;
				const key = `${repoRoot}\n${refs[0].baseRef}\n${baseCommit}\n${refs[1]}\n${worktree ? state : "committed"}`;
				const existing = entries.get(key);
				if (existing !== undefined && Date.now() - existing.at < 30_000) {
					yield* Effect.annotateCurrentSpan("reused", true);
					return yield* Fiber.join(existing.fiber);
				}
				if (entries.size >= 8) {
					const oldest = entries.keys().next();
					if (!oldest.done) entries.delete(oldest.value);
				}
				// Runs in the service scope, not the first caller's fiber: callers
				// share this fiber's result, so one of them being interrupted (e.g. the
				// client aborting its request) must never cancel it for the others.
				const fiber = yield* Effect.fiber.pipe(
					Effect.flatMap((current) => {
						const shared = current as SharedPreparation;
						return effect.pipe(
							Effect.tap(() =>
								Effect.gen(function* () {
									if (
										state !== undefined &&
										state === (yield* validationState)
									) {
										if (validated.size >= 8) {
											const oldest = validated.keys().next();
											if (!oldest.done) validated.delete(oldest.value);
										}
										validated.set(validationKey, { state, fiber: shared });
									} else if (worktree && entries.get(key)?.fiber === shared)
										entries.delete(key);
								}),
							),
							Effect.onExit((exit) =>
								Exit.isSuccess(exit)
									? Effect.void
									: Effect.sync(() => {
											if (entries.get(key)?.fiber === shared)
												entries.delete(key);
											if (validated.get(validationKey)?.fiber === shared)
												validated.delete(validationKey);
										}),
							),
						);
					}),
					Effect.forkIn(scope),
				);
				entries.set(key, { at: Date.now(), fiber });
				return yield* Fiber.join(fiber);
			}).pipe(Effect.withSpan("diff.preparation.read"));
		return { read, localBase };
	});
