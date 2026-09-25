import { GhGitHub } from "../../src/github/gh/github.ts";
import { Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { GhStackMergeFailed } from "../../src/errors.ts";
import { GitHub } from "../../src/github/github.ts";

const outcome = process.argv[2];
if (outcome !== "merged" && outcome !== "failed") {
	throw new Error("usage: merge-stack-runner.ts <merged|failed>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			return yield* github.mergeStack("/tmp", "acme", "widgets", 42, "squash");
		}),
	).pipe(
		Effect.provide(GhGitHub.layer.pipe(Layer.provideMerge(BunServices.layer))),
	),
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
