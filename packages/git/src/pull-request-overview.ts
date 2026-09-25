import { Effect } from "effect";
import { GitHub } from "./github/github.ts";
export type {
	FetchPullRequestOverviewInput,
	OverviewCommit,
	OverviewCommitCheck,
	PullRequestOverview,
} from "./github/models.ts";
export const fetchPullRequestOverview = (
	input: import("./github/models.ts").FetchPullRequestOverviewInput,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.overview(input);
	});
