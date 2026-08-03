/**
 * Runs `searchPullRequests` once and prints its outcome as one line of JSON —
 * spawned as a *fresh process* (not imported directly) by
 * `search-pull-requests.test.ts`, same reason as
 * `resolve-review-target-runner.ts`: `@repo/git`'s `exec.ts` resolves
 * `NISI_GH_BIN` once at module load via a top-level `const`, so pointing `gh`
 * at `fixtures/gh-search-stub.sh` only takes effect in a process that hasn't
 * already imported `exec.ts` with the real binary.
 */
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { searchPullRequests } from "../../src/pull-request.ts";

const [cwd, query] = process.argv.slice(2);
if (cwd === undefined || query === undefined) {
	throw new Error("usage: search-pull-requests-runner.ts <cwd> <query>");
}

const exit = await Effect.runPromise(
	Effect.exit(searchPullRequests(cwd, query)).pipe(
		Effect.provide(BunServices.layer),
	),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const, results: exit.value }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
