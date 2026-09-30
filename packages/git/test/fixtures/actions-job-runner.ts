import { Cause, Effect, Exit } from "effect";
import { GitHub } from "../../src/github/github.ts";
import { GitHubTestLayer } from "./github-layer.ts";

const exit = await Effect.runPromise(
	Effect.exit(
		Effect.gen(function* () {
			const root = process.argv[2];
			const action = process.argv[3];
			const id = process.argv[4];
			if (root === undefined || id === undefined)
				return yield* Effect.die(new Error("Missing runner arguments"));
			const input = {
				repoRoot: root,
				owner: "acme",
				repo: "widgets",
				number: 42,
				jobId: Number(id),
			};
			const github = yield* GitHub;
			if (action === "job") return { job: yield* github.getActionsJob(input) };
			if (action === "logs")
				return { logs: yield* github.getActionsJobLogs(input) };
			if (action === "rerun") {
				yield* github.rerunActionsJob(input);
				return {};
			}
			return yield* Effect.die(new Error("Unknown runner action"));
		}),
	).pipe(Effect.provide(GitHubTestLayer)),
);

const result = Exit.isSuccess(exit)
	? { ok: true, ...exit.value }
	: { ok: false, error: Cause.squash(exit.cause) };
process.stdout.write(JSON.stringify(result));
