export type SearchableModelOption = {
	harness: string;
	harnessLabel: string;
	modelId: string | undefined;
	label: string;
};

function compact(text: string): string {
	return text.replace(/[^a-z0-9]/g, "");
}

export function matchesModelQuery(
	option: SearchableModelOption,
	query: string,
): boolean {
	const haystack = [
		option.harnessLabel,
		option.harness,
		option.modelId,
		option.label,
	]
		.filter((part) => part !== undefined)
		.join(" ")
		.toLowerCase();
	const compactHaystack = compact(haystack);
	return query
		.toLowerCase()
		.trim()
		.split(/\s+/)
		.every((token) => {
			const compactToken = compact(token);
			return (
				haystack.includes(token) ||
				(compactToken.length > 0 && compactHaystack.includes(compactToken))
			);
		});
}
