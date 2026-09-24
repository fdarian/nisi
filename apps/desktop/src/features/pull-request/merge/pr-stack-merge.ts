import type { PullRequestStack } from "#/features/pull-request/data/pr-data";

export type StackMergeInfo = {
	count: number;
};

/** Returns the stack merge's unmerged layer count for a current, unmerged stack member. */
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
	return { count };
}
