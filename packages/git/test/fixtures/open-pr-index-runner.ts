import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Result } from "effect";
import { listOpenPullRequests } from "../../src/github/gh/open-pull-requests.ts";
import type { OpenPullRequestIndex } from "../../src/github/github.ts";

BunRuntime.runMain(
	Effect.gen(function* () {
		const cwd = process.argv[2];
		if (cwd === undefined) return yield* Effect.die("missing cwd");
		const pages: OpenPullRequestIndex[] = [];
		const updatedSince = process.argv[3];
		const result = yield* listOpenPullRequests(cwd, "acme", "project", {
			...(updatedSince === undefined ? {} : { updatedSince }),
			onPage: (page) =>
				Effect.sync(() => {
					pages.push(page);
				}),
		}).pipe(Effect.result);
		yield* Console.log(
			JSON.stringify(
				Result.isSuccess(result)
					? { ok: true, value: result.success, pages }
					: { ok: false, tag: result.failure._tag },
			),
		);
	}).pipe(Effect.provide(BunServices.layer)),
);
