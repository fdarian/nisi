/**
 * Runs `searchPullRequests` once and prints its outcome as one line of JSON —
 * spawned as a *fresh process* (not imported directly) by
 * `search-pull-requests.test.ts`, same reason as
 * `resolve-review-target-runner.ts`: `@repo/git`'s `exec.ts` resolves
 * `NISI_GH_BIN` once at module load via a top-level `const`, so pointing `gh`
 * at `fixtures/gh-search-stub.sh` only takes effect in a process that hasn't
 * already imported `exec.ts` with the real binary.
 */
import { Cause, Clock, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";
import type { PullRequestSearchState } from "../../src/pull-request.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const [cwd, query, state] = process.argv.slice(2);
if (cwd === undefined || query === undefined) {
	throw new Error(
		"usage: search-pull-requests-runner.ts <cwd> <query> <open|closed> [repo...]",
	);
}
if (state !== "open" && state !== "closed") {
	throw new Error(`state must be open or closed, got ${state}`);
}
const searchState: PullRequestSearchState = state;

const nowIso = process.env.NISI_NOW_ISO;
const withFixedNow = <A, E, R>(
	iso: string,
	program: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
	Effect.gen(function* () {
		const real = yield* Clock.Clock;
		const millis = Date.parse(iso);
		return yield* program.pipe(
			Effect.provideService(Clock.Clock, {
				currentTimeMillisUnsafe: () => millis,
				currentTimeMillis: Effect.succeed(millis),
				currentTimeNanosUnsafe: () => BigInt(millis) * 1_000_000n,
				currentTimeNanos: Effect.succeed(BigInt(millis) * 1_000_000n),
				monotonicTimeNanosUnsafe: () => real.monotonicTimeNanosUnsafe(),
				monotonicTimeNanos: real.monotonicTimeNanos,
				sleep: (duration) => real.sleep(duration),
			}),
		);
	});

const search = Effect.gen(function* () {
	const github = yield* GitHub;
	return yield* github.search(cwd, query, process.argv.slice(5), searchState);
});

const exit = await Effect.runPromise(
	Effect.exit(
		nowIso === undefined ? search : withFixedNow(nowIso, search),
	).pipe(Effect.provide(GitHubTestLayer)),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const, results: exit.value }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
