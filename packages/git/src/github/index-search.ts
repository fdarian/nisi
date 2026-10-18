import type { PullRequestSearchResult } from "../pull-request.ts";
import { SEARCH_LIMIT } from "./gh/pull-request.ts";
import type { OpenPullRequestIndex } from "./github.ts";

const NUMBER_TERM = /^(#?)(\d+)$/;

/**
 * Local counterpart of `searchPullRequests` over the sidecar's in-memory
 * open-PR index. Understands no GitHub qualifiers — the caller decides
 * whether a query is index-answerable (`hasSearchQualifier`) before using it.
 *
 * Each whitespace-separated term must match (AND), case-insensitively, as a
 * substring of the title, head branch, `owner/repo` or author. A bare number
 * (`123`, `#123`) matches the PR number exactly; without a `#` it may also match as a substring (`v12`, a year in a title).
 */
export const searchOpenPullRequestIndexes = (
	indexes: Iterable<OpenPullRequestIndex>,
	query: string,
	repos: readonly string[],
): PullRequestSearchResult[] => {
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((term) => term.length > 0);
	const repoFilter = new Set(repos.map((repo) => repo.toLowerCase()));
	if (terms.length === 0 && repoFilter.size === 0) return [];

	const results: PullRequestSearchResult[] = [];
	for (const index of indexes) {
		const slug = `${index.repository.owner}/${index.repository.repo}`;
		const lowerSlug = slug.toLowerCase();
		if (repoFilter.size > 0 && !repoFilter.has(lowerSlug)) continue;
		for (const pr of index.prs) {
			if (pr.state !== "OPEN") continue;
			const fields = [pr.title, pr.headRef, slug, pr.author].map((field) =>
				field.toLowerCase(),
			);
			const matchesAll = terms.every((term) => {
				const numberMatch = NUMBER_TERM.exec(term);
				if (numberMatch === null) return fields.some((f) => f.includes(term));
				const digits = numberMatch[2] ?? "";
				if (Number(digits) === pr.number) return true;
				return numberMatch[1] === "" && fields.some((f) => f.includes(digits));
			});
			if (!matchesAll) continue;
			results.push({
				owner: index.repository.owner,
				repo: index.repository.repo,
				number: pr.number,
				title: pr.title,
				author: pr.author,
				updatedAt: pr.updatedAt,
				url: pr.url,
				isDraft: pr.isDraft,
				state: pr.state,
				mergeable: pr.mergeable,
				mergeStateStatus: pr.mergeStateStatus,
				rollupState: pr.rollupState,
			});
		}
	}
	return results
		.sort((a, b) =>
			a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
		)
		.slice(0, SEARCH_LIMIT);
};
