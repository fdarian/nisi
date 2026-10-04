import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Result } from "effect";
import { listOpenPullRequests } from "../../src/github/gh/open-pull-requests.ts";
BunRuntime.runMain(
	Effect.gen(function* () {
		const cwd = process.argv[2];
		if (cwd === undefined) return yield* Effect.die("missing cwd");
		const result = yield* listOpenPullRequests(cwd, "acme", "project").pipe(
			Effect.result,
		);
		yield* Console.log(
			JSON.stringify(
				Result.isSuccess(result)
					? { ok: true, value: result.success }
					: { ok: false, tag: result.failure._tag },
			),
		);
	}).pipe(Effect.provide(BunServices.layer)),
);
