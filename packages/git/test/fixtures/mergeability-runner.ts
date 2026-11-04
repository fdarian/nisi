/**
 * Runs `mergeability` and prints its outcome as one line of JSON — spawned as
 * a *fresh process* by `pull-request-mergeability.test.ts`, since `@repo/git`'s
 * `exec.ts` resolves `NISI_GH_BIN` once at module load. See
 * `search-pull-requests-runner.ts`'s doc comment for the full reasoning.
 */
import { Cause, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			return yield* github.mergeability("/tmp", "acme", "widgets", 42);
		}),
	).pipe(Effect.provide(GitHubTestLayer)),
);

console.log(
	JSON.stringify(
		Exit.isSuccess(exit)
			? { ok: true as const, value: exit.value }
			: {
					ok: false as const,
					tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
				},
	),
);
