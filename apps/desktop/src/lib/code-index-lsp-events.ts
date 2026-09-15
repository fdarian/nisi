import type { CodeIndexLspStatusName, SessionEvent } from "@repo/sidecar-api";

export type CodeIndexLspStatusEvent = Extract<
	SessionEvent,
	{ type: "code-index-lsp-status-changed" }
>;

export type CodeIndexLspSession = {
	id: string;
	repoRoot: string;
};

export const sessionIdsForCodeIndexLspStatus = (
	sessions: readonly CodeIndexLspSession[],
	event: CodeIndexLspStatusEvent,
): readonly string[] =>
	sessions
		.filter((session) => session.repoRoot === event.repoRoot)
		.map((session) => session.id);

export const codeIndexLspIntentForStatus = (
	status: CodeIndexLspStatusName,
): boolean => status !== "off";
