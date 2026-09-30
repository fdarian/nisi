import type { GitCommandError, PullRequestMergeError } from "@repo/git";

export const translateMergeFailure = (
	cause: PullRequestMergeError | GitCommandError,
): {
	code:
		| "GH_NOT_AUTHENTICATED"
		| "NOT_FOUND"
		| "CONFLICT"
		| "SERVICE_UNAVAILABLE";
	reason: string;
	detail: string;
	message: string;
} => {
	switch (cause._tag) {
		case "GhNotAuthenticated":
			return {
				code: "GH_NOT_AUTHENTICATED",
				reason: "Authentication required",
				detail: cause.reason,
				message: `gh is not authenticated: ${cause.reason}`,
			};
		case "PullRequestNotFound":
			return {
				code: "NOT_FOUND",
				reason: "Pull request not found",
				detail: cause.reason,
				message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
			};
		case "PullRequestNotMergeable":
			return {
				code: "CONFLICT",
				reason: "Merge blocked",
				detail: cause.reason,
				message: `pull request #${cause.number} isn't mergeable right now: ${cause.reason}`,
			};
		case "GhMergeFailed":
			return {
				code: "SERVICE_UNAVAILABLE",
				reason: "GitHub rejected the merge",
				detail: cause.reason,
				message: `gh pr merge failed for pull request #${cause.number}: ${cause.reason}`,
			};
		case "GitCommandError":
			return {
				code: "SERVICE_UNAVAILABLE",
				reason: "Couldn't run gh",
				detail: `${cause.command} ${cause.args.join(" ")} (exit ${cause.exitCode}): ${cause.stderr}\n${String(cause.cause)}`,
				message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
			};
	}
};
