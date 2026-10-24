const FILTER_TERMS = ["closed", "recently closed", "merged"];

const MIN_QUERY_LENGTH = 2;

/** Whether the typed query is heading towards the "Recently closed" filter, so the palette offers it as a row. */
export function offersRecentlyClosedFilter(query: string): boolean {
	const normalized = query.trim().toLowerCase();
	if (normalized.length < MIN_QUERY_LENGTH) return false;
	return FILTER_TERMS.some((term) => term.startsWith(normalized));
}
