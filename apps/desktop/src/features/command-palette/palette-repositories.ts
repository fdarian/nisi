import type { PullRequestRepository } from "../pull-request/data/pull-requests-data";

export function repositoryKey(repository: PullRequestRepository): string {
	return `${repository.owner}/${repository.repo}`;
}

/**
 * Local (recent, then saved) entries are filtered by what's typed; `remote`
 * GitHub search hits are appended unfiltered, since GitHub's token-based
 * matching already decided they're relevant and a substring test would drop
 * valid hits (e.g. a typed `web app` matching `acme/web-app`).
 */
export function paletteRepositories(
	recent: readonly PullRequestRepository[],
	saved: readonly PullRequestRepository[],
	applied: readonly PullRequestRepository[],
	query: string,
	remote: readonly PullRequestRepository[],
): PullRequestRepository[] {
	const seen = new Set(
		applied.map((repository) => repositoryKey(repository).toLowerCase()),
	);
	const needle = query.toLowerCase();
	const local = [...recent, ...saved].filter((repository) => {
		const key = repositoryKey(repository).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return key.includes(needle);
	});
	const remoteOnly = remote.filter((repository) => {
		const key = repositoryKey(repository).toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	return [...local, ...remoteOnly];
}
