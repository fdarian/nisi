/**
 * Runs one of `pull-request.ts`'s two `ReviewTarget` resolvers and prints its
 * outcome as one line of JSON — spawned as a *fresh process* (not imported
 * directly) by `review-target-by-number.test.ts`, since `@repo/git`'s `exec.ts`
 * resolves `NISI_GH_BIN` once at module load via a top-level `const`. A test
 * running in the same process as every other file in this package's `bun
 * test` run has already loaded that module (real `gh`, unset override) by the
 * time it would want to point `gh` at the stub in `fixtures/gh-stub.sh` — a
 * separate process with the env var set before this script's first import is
 * the only way to make the override actually take effect.
 */
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import {
	resolveReviewTarget,
	resolveReviewTargetForPullRequest,
} from "../../src/pull-request.ts";

const [mode, repoRoot, numberArg] = process.argv.slice(2);
if (mode === undefined || repoRoot === undefined) {
	throw new Error(
		"usage: resolve-review-target-runner.ts <mode> <repoRoot> [number]",
	);
}

const target =
	mode === "byNumber"
		? resolveReviewTargetForPullRequest(repoRoot, Number(numberArg))
		: resolveReviewTarget(repoRoot);

const exit = await Effect.runPromise(
	Effect.exit(target).pipe(Effect.provide(BunServices.layer)),
);

const result = Exit.isSuccess(exit)
	? {
			ok: true as const,
			defaultBranch: exit.value.defaultBranch,
			owner: exit.value.github?.owner ?? null,
			prNumber: exit.value.github?.pr?.number ?? null,
			prTitle: exit.value.github?.pr?.title ?? null,
		}
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
