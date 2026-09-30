import type { PullRequestRepository } from "../pull-request/data/pull-requests-data";

export function repositoryKey(repository: PullRequestRepository): string {
	return `${repository.owner}/${repository.repo}`;
}

export function paletteRepositories(
	recent: readonly PullRequestRepository[],
	saved: readonly PullRequestRepository[],
	applied: readonly PullRequestRepository[],
	query: string,
): PullRequestRepository[] {
	const seen = new Set(
		applied.map((repository) => repositoryKey(repository).toLowerCase()),
	);
	const needle = query.toLowerCase();
	return [...recent, ...saved].filter((repository) => {
		const key = repositoryKey(repository).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return key.includes(needle);
	});
}
