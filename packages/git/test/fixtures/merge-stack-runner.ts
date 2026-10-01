import { Cause, Effect, Exit } from "effect";
import { GhStackMergeFailed } from "../../src/errors.ts";
import { GitHub } from "../../src/github/github.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const outcome = process.argv[2];
const route = process.argv[3];
const matchHeadCommit = process.argv[4];
if (outcome !== "merged" && outcome !== "failed") {
	throw new Error("usage: merge-stack-runner.ts <merged|failed>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			const merge = route === "regular" ? github.merge : github.mergeStack;
			return yield* merge(
				"/tmp",
				"acme",
				"widgets",
				42,
				"squash",
				matchHeadCommit,
			);
		}),
	).pipe(Effect.provide(GitHubTestLayer)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify({ ok: true as const }));
} else {
	const failure = Cause.squash(exit.cause);
	if (!(failure instanceof GhStackMergeFailed)) {
		throw new Error("expected GhStackMergeFailed");
	}
	console.log(
		JSON.stringify({
			ok: false as const,
			tag: failure._tag,
			reason: failure.reason,
		}),
	);
}
