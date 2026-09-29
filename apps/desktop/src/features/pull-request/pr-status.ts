export type PrStatus =
	| "merged"
	| "conflicts"
	| "draft"
	| "ci-running"
	| "ready"
	| "default";

type PrStatusInput = {
	state?: string;
	isDraft?: boolean;
	mergeable?: string;
	mergeStateStatus?: string;
	ciRunning?: boolean;
};

export function derivePrStatus(input: PrStatusInput): PrStatus {
	if (input.state === "MERGED") return "merged";
	if (input.mergeable === "CONFLICTING" || input.mergeStateStatus === "DIRTY")
		return "conflicts";
	if (input.isDraft === true) return "draft";
	if (input.ciRunning === true) return "ci-running";
	if (input.mergeable === "MERGEABLE" && input.mergeStateStatus === "CLEAN")
		return "ready";
	return "default";
}
