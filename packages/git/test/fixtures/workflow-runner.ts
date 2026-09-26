import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit } from "effect";
import {
	approveWorkflowRuns,
	fetchPullRequestChecks,
} from "../../src/github/gh/checks.ts";

const operation = process.argv[2];
if (operation === "fetch-truncated") process.env.NISI_TEST_TRUNCATED = "1";
const input = { repoRoot: "/tmp", owner: "acme", repo: "widgets" };
const effect = Effect.gen(function* () {
	if (operation === "fetch" || operation === "fetch-truncated")
		return yield* fetchPullRequestChecks({ ...input, number: 42 });
	yield* approveWorkflowRuns({
		...input,
		runIds: operation === "forbidden" ? [101, 102] : [101],
	});
});
const exit = await Effect.runPromise(
	Effect.exit(effect).pipe(Effect.provide(BunServices.layer)),
);
console.log(
	JSON.stringify(
		Exit.isSuccess(exit)
			? { ok: true, value: exit.value }
			: { ok: false, tag: (Cause.squash(exit.cause) as { _tag: string })._tag },
	),
);
