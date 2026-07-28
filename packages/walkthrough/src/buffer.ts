/**
 * The single implicit output target the `write`/`edit` tools mutate. There
 * is exactly one walkthrough per turn, so unlike Claude Code's own
 * file-scoped editing tools these take no path — `content` is the whole
 * answer.
 */
export type WalkthroughBuffer = {
	content: string;
};

export const createBuffer = (initialContent = ""): WalkthroughBuffer => ({
	content: initialContent,
});

export type EditFailure =
	| { readonly reason: "buffer-empty" }
	| { readonly reason: "no-op" }
	| { readonly reason: "not-found"; readonly oldString: string }
	| {
			readonly reason: "ambiguous-match";
			readonly oldString: string;
			readonly matchCount: number;
	  };

export type EditOutcome =
	| { readonly ok: true; readonly content: string }
	| { readonly ok: false; readonly failure: EditFailure };

const countOccurrences = (haystack: string, needle: string): number =>
	needle.length === 0 ? 0 : haystack.split(needle).length - 1;

/**
 * Claude Code's own Edit tool semantics, applied to the walkthrough buffer
 * instead of a file: `oldString` must match exactly (including whitespace)
 * and be unique unless `replaceAll` is set, so the model driving this
 * doesn't need to learn a second dialect. Pure — the caller (`tools.ts`)
 * decides whether to commit the result to the buffer.
 */
export const applyEdit = (
	currentContent: string,
	oldString: string,
	newString: string,
	replaceAll: boolean,
): EditOutcome => {
	if (currentContent.length === 0) {
		return { ok: false, failure: { reason: "buffer-empty" } };
	}
	if (oldString === newString) {
		return { ok: false, failure: { reason: "no-op" } };
	}
	const matchCount = countOccurrences(currentContent, oldString);
	if (matchCount === 0) {
		return { ok: false, failure: { reason: "not-found", oldString } };
	}
	if (!replaceAll && matchCount > 1) {
		return {
			ok: false,
			failure: { reason: "ambiguous-match", oldString, matchCount },
		};
	}
	const content = replaceAll
		? currentContent.split(oldString).join(newString)
		: currentContent.replace(oldString, newString);
	return { ok: true, content };
};

/** A clear, actionable message for each way an edit can fail — a vague error wastes a turn. */
export const describeEditFailure = (failure: EditFailure): string => {
	switch (failure.reason) {
		case "buffer-empty":
			return "The walkthrough buffer is empty. Use `write` to create it before using `edit`.";
		case "no-op":
			return "oldString and newString are identical — nothing to change.";
		case "not-found":
			return `The string to replace was not found in the walkthrough buffer. Make sure it matches exactly, including whitespace:\n\n${failure.oldString}`;
		case "ambiguous-match":
			return `Found ${failure.matchCount} matches for the string to replace. Provide more surrounding context to make it unique, or pass replaceAll: true to replace every occurrence.\n\nString:\n${failure.oldString}`;
	}
};
