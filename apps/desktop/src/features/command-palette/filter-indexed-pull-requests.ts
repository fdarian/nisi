import type { IndexedPullRequest } from "#/features/pull-request/data/pull-requests-data";

const NUMBER_TERM = /^#?\d+$/;

/** Matches GitHub's own search page size, which the `gh` fallback returns. */
const RESULT_LIMIT = 30;

type Term = {
	text: string;
	/** Set for `123` / `#123`: the digits, which name the PR number. */
	digits: string | null;
	/** A leading `#` limits the term to the PR number; without it, the digits may also match as text. */
	numberOnly: boolean;
};

function parseTerm(text: string): Term {
	if (!NUMBER_TERM.test(text)) return { text, digits: null, numberOnly: false };
	return {
		text,
		digits: text.replace("#", ""),
		numberOnly: text.startsWith("#"),
	};
}

function namesNumber(term: Term, number: number): boolean {
	return term.digits !== null && Number(term.digits) === number;
}

function hitsAny(term: Term, fields: readonly string[]): boolean {
	if (term.digits === null) return fields.some((f) => f.includes(term.text));
	const digits = term.digits;
	return !term.numberOnly && fields.some((f) => f.includes(digits));
}

/** 0: a term names the PR number; 1: a term hits the title or branch; 2: only owner/repo or author matched. */
function rank(pr: IndexedPullRequest, terms: readonly Term[]): 0 | 1 | 2 {
	if (terms.some((term) => namesNumber(term, pr.number))) return 0;
	const prose = [pr.title.toLowerCase(), pr.headRefName.toLowerCase()];
	return terms.some((term) => hitsAny(term, prose)) ? 1 : 2;
}

/**
 * Filters the sidecar's open-PR index as the user types. Understands no
 * GitHub qualifiers — the caller sends those to `gh` (`hasSearchQualifier`).
 *
 * Each whitespace-separated term must match (AND), case-insensitively, as a
 * substring of the title, head branch, `owner/repo` or author. A bare number
 * (`123`, `#123`) matches the PR number exactly; without a `#` it may also
 * match as a substring (`v12`, a year in a title). `repos` (`owner/repo`)
 * restricts the rows; with no terms it lists them all. No terms and no repos
 * matches nothing — that is the palette's recent-PRs state, not a filter.
 *
 * Ordered by how directly the query names the row — number match, then
 * title/branch hit, then the rest — most recently updated first within each.
 */
export function filterIndexedPullRequests(
	rows: readonly IndexedPullRequest[],
	query: string,
	repos: readonly string[],
): IndexedPullRequest[] {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((text) => text.length > 0)
		.map(parseTerm);
	const repoFilter = new Set(repos.map((repo) => repo.toLowerCase()));
	if (terms.length === 0 && repoFilter.size === 0) return [];

	const ranked: { pr: IndexedPullRequest; rank: 0 | 1 | 2 }[] = [];
	for (const pr of rows) {
		const slug = `${pr.owner}/${pr.repo}`.toLowerCase();
		if (repoFilter.size > 0 && !repoFilter.has(slug)) continue;
		const fields = [
			pr.title.toLowerCase(),
			pr.headRefName.toLowerCase(),
			slug,
			pr.author.toLowerCase(),
		];
		const matchesAll = terms.every((term) => {
			return namesNumber(term, pr.number) || hitsAny(term, fields);
		});
		if (matchesAll) ranked.push({ pr, rank: rank(pr, terms) });
	}
	return ranked
		.sort(
			(a, b) =>
				a.rank - b.rank ||
				(a.pr.updatedAt < b.pr.updatedAt
					? 1
					: a.pr.updatedAt > b.pr.updatedAt
						? -1
						: 0),
		)
		.slice(0, RESULT_LIMIT)
		.map((entry) => entry.pr);
}
