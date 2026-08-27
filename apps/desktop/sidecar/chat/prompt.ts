/** What `chat.send` names to the agent — just enough to orient it, not a diff briefing (see `buildChatInstructions`'s doc). */
export type ChatPromptContext = {
	readonly repoRoot: string;
	readonly baseRef: string;
	readonly headRef: string;
	readonly pullRequest: {
		readonly owner: string;
		readonly repo: string;
		readonly number: number;
		readonly title: string;
	} | null;
};

/**
 * Deliberately thin: names the repo/branch/PR under review and hands the
 * agent read-only tools, nothing more. Unlike `@repo/walkthrough`'s
 * `buildOverview` (a full per-file diff briefing `generate.ts` gathers up
 * front), chat's agent has `bash`/`read`/`grep`/`glob` against the same real
 * worktree and can look for itself — growing this into a second diff
 * briefing would duplicate `gatherGenerationContext`'s job for a much
 * shorter-lived conversation.
 */
export const buildChatInstructions = (context: ChatPromptContext): string => {
	const target =
		context.pullRequest === null
			? `branch \`${context.headRef}\` compared against \`${context.baseRef}\``
			: `${context.pullRequest.owner}/${context.pullRequest.repo}#${context.pullRequest.number} ("${context.pullRequest.title}"), branch \`${context.headRef}\` targeting \`${context.baseRef}\``;

	return [
		`You are answering questions about a pull request under review, working directly in the user's local git checkout at \`${context.repoRoot}\`.`,
		`This is ${target}.`,
		"You have read-only tools — explore the repository and its diff as needed to answer accurately, but never modify anything in the worktree.",
		"Keep answers concise and grounded in what you actually find by exploring the repository.",
	].join("\n\n");
};
