/**
 * Runs `markPullRequestReady` and prints its outcome as one line of JSON —
 * spawned as a *fresh process* (not imported directly) by
 * `mark-pull-request-ready.test.ts`, since `@repo/git`'s `exec.ts` resolves
 * `NISI_GH_BIN` once at module load via a top-level `const`. See
 * `search-pull-requests-runner.ts`'s doc comment for the full reasoning.
 */
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { markPullRequestReady } from "../../src/pull-request-merge.ts";

const [repoRoot, numberArg] = process.argv.slice(2);
if (repoRoot === undefined || numberArg === undefined) {
	throw new Error(
		"usage: mark-pull-request-ready-runner.ts <repoRoot> <number>",
	);
}

const exit = await Effect.runPromise(
	Effect.exit(markPullRequestReady(repoRoot, Number(numberArg))).pipe(
		Effect.provide(BunServices.layer),
	),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
