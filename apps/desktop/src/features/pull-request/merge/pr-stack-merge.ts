import type { PullRequestStack } from "#/lib/pr-data";

export type StackMergeInfo = {
	count: number;
};

/** Returns the number of unmerged layers that GitHub will merge through the current PR. */
export function deriveStackMerge(
	stack: PullRequestStack | null | undefined,
	currentNumber: number,
): StackMergeInfo | null {
	if (stack === null || stack === undefined) return null;

	const current = stack.entries.find((entry) => entry.number === currentNumber);
	if (current === undefined || current.state === "MERGED") return null;

	const count = stack.entries.filter(
		(entry) => entry.position <= current.position && entry.state !== "MERGED",
	).length;
	return count > 1 ? { count } : null;
}
