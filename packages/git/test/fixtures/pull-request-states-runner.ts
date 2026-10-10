/**
 * Runs `pullRequestStates` and prints its outcome as one line of JSON —
 * spawned as a *fresh process* by `pull-request-states.test.ts`, since
 * `exec.ts` resolves `NISI_GH_BIN` once at module load. See
 * `search-pull-requests-runner.ts`.
 */
import { Cause, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const [owner, repo] = process.argv.slice(2);
if (owner === undefined || repo === undefined) {
	throw new Error("usage: pull-request-states-runner.ts <owner> <repo>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			return yield* github.pullRequestStates("/tmp", owner, repo);
		}),
	).pipe(Effect.provide(GitHubTestLayer)),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const, states: exit.value }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
