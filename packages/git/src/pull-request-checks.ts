import { Effect } from "effect";
import { GitHub } from "./github/github.ts";
export type {
	FetchPullRequestChecksInput,
	PullRequestCheck,
	PullRequestCheckStatus,
} from "./github/models.ts";
export {
	CheckRunView,
	StatusContextView,
	toPullRequestCheck,
} from "./github/gh/checks.ts";
export const fetchPullRequestChecks = (
	input: import("./github/models.ts").FetchPullRequestChecksInput,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.checks(input);
	});
