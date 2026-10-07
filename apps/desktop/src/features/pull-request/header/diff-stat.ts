export type DiffStat =
	| { status: "loading" }
	| { status: "unavailable" }
	| { status: "ready"; additions: number; deletions: number };

/** `loading` and `unavailable` are distinct from `+0 -0`: an empty diff is a real answer, a missing one is not. */
export function diffStat(input: {
	files: readonly { additions: number; deletions: number }[];
	isLoading: boolean;
	error: unknown;
}): DiffStat {
	if (input.error != null) return { status: "unavailable" };
	if (input.isLoading) return { status: "loading" };
	return {
		status: "ready",
		additions: input.files.reduce((sum, file) => sum + file.additions, 0),
		deletions: input.files.reduce((sum, file) => sum + file.deletions, 0),
	};
}
