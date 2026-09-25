import { Effect } from "effect";
import { GitHub } from "./github/github.ts";
export type {
	FetchPullRequestStackInput,
	PullRequestStack,
	PullRequestStackEntry,
	PullRequestStackError,
} from "./github/models.ts";
export const fetchPullRequestStack = (
	input: import("./github/models.ts").FetchPullRequestStackInput,
) =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		return yield* github.stack(input);
	});
