import { Cause, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const github = yield* GitHub;
			return yield* github.createStack({
				repoRoot: "/tmp",
				owner: "acme",
				repo: "widgets",
				numbers: [41, 42, 43],
			});
		}),
	).pipe(Effect.provide(GitHubTestLayer)),
);

if (Exit.isSuccess(exit)) {
	console.log(JSON.stringify({ ok: true as const }));
} else {
	const failure = Cause.squash(exit.cause) as {
		readonly _tag: string;
		readonly reason: string;
	};
	console.log(
		JSON.stringify({
			ok: false as const,
			tag: failure._tag,
			reason: failure.reason,
		}),
	);
}
