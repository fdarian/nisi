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
 * Deliberately thin: names the repo/branch/PR under review, nothing more.
 * Unlike `@repo/walkthrough`'s `buildOverview` (a full per-file diff
 * briefing `generate.ts` gathers up front), chat's agent has its full tool
 * set — `bash`/`read`/`grep`/`glob`/`write`/`edit`, the same builtins a
 * standalone `claude`/`codex`/`opencode` session would have — against the
 * same real worktree, and can look (or act) for itself. Growing this into a
 * second diff briefing would duplicate `gatherGenerationContext`'s job for a
 * much shorter-lived conversation.
 */
export const buildChatInstructions = (context: ChatPromptContext): string => {
	const target =
		context.pullRequest === null
			? `branch \`${context.headRef}\` compared against \`${context.baseRef}\``
			: `${context.pullRequest.owner}/${context.pullRequest.repo}#${context.pullRequest.number} ("${context.pullRequest.title}"), branch \`${context.headRef}\` targeting \`${context.baseRef}\``;

	return [
		`You are chatting with the user about a pull request under review, working directly in the user's local git checkout at \`${context.repoRoot}\`.`,
		`This is ${target}.`,
		"You have your full set of tools available — read, write, edit, run commands, whatever the conversation calls for.",
		"Keep answers concise and grounded in what you actually find by exploring the repository.",
	].join("\n\n");
};
