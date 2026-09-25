import { GhGitHub } from "../../src/github/gh/github.ts";
import { Layer } from "effect";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";

const numberArg = process.argv[2];
if (numberArg === undefined) {
	throw new Error("usage: fetch-pull-request-stack-runner.ts <number>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			return yield* github.stack({
				repoRoot: "/tmp",
				owner: "acme",
				repo: "widgets",
				number: Number(numberArg),
			});
		}),
	).pipe(
		Effect.provide(GhGitHub.layer.pipe(Layer.provideMerge(BunServices.layer))),
	),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const, value: exit.value }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
