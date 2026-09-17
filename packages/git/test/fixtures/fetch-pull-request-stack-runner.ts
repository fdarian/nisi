import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import { fetchPullRequestStack } from "../../src/pull-request-stack.ts";

const numberArg = process.argv[2];
if (numberArg === undefined) {
	throw new Error("usage: fetch-pull-request-stack-runner.ts <number>");
}

const exit = await Effect.runPromise(
	Effect.exit(
		fetchPullRequestStack({
			repoRoot: "/tmp",
			owner: "acme",
			repo: "widgets",
			number: Number(numberArg),
		}),
	).pipe(Effect.provide(BunServices.layer)),
);

const result = Exit.isSuccess(exit)
	? { ok: true as const, value: exit.value }
	: {
			ok: false as const,
			tag: (Cause.squash(exit.cause) as { readonly _tag: string })._tag,
		};

console.log(JSON.stringify(result));
