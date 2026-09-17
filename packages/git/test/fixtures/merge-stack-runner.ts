import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { GhStackMergeFailed } from "../../src/errors.ts";
import { mergeStackPullRequest } from "../../src/pull-request-merge.ts";

const outcome = process.argv[2];
if (outcome !== "merged" && outcome !== "failed") {
	throw new Error("usage: merge-stack-runner.ts <merged|failed>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		mergeStackPullRequest("/tmp", "acme", "widgets", 42, "squash"),
	).pipe(Effect.provide(BunServices.layer)),
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
