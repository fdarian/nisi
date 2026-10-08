import {
	type GitCommandError,
	GitHub,
	originUrlOrNull,
	type PullRequestStateError,
	verifyRepoPathMatchesOrigin,
} from "@repo/git";
import {
	type PullRequestSessionRecord,
	ReviewStore,
	type ReviewStoreError,
	type SessionNotFound,
} from "@repo/review";
import { SettingsStore, type SettingsStoreError } from "@repo/settings";
import type {
	RepositoryDetail,
	RepositoryProblem,
	RepositorySummary,
} from "@repo/sidecar-api";
import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { PrIndex } from "./pr-index.ts";

type PrState = "open" | "merged" | "closed";

type KnownRepository = {
	readonly owner: string;
	readonly repo: string;
	readonly path: string | null;
	readonly sessions: ReadonlyArray<PullRequestSessionRecord>;
};

const repositoryKey = (owner: string, repo: string) =>
	`${owner}/${repo}`.toLowerCase();

/** Joins recorded checkout paths with PR sessions on case-insensitive `owner/repo`; a path's spelling wins, since GitHub reports it as typed there. */
export const collectRepositories = (
	mappings: ReadonlyArray<{
		readonly owner: string;
		readonly repo: string;
		readonly path: string;
	}>,
	sessions: ReadonlyArray<PullRequestSessionRecord>,
): ReadonlyArray<KnownRepository> => {
	const known = new Map<
		string,
		{
			owner: string;
			repo: string;
			path: string | null;
			sessions: PullRequestSessionRecord[];
		}
	>();
	for (const mapping of mappings)
		known.set(repositoryKey(mapping.owner, mapping.repo), {
			owner: mapping.owner,
			repo: mapping.repo,
			path: mapping.path,
			sessions: [],
		});
	for (const session of sessions) {
		const key = repositoryKey(session.owner, session.repo);
		const entry = known.get(key);
		if (entry === undefined)
			known.set(key, {
				owner: session.owner,
				repo: session.repo,
				path: null,
				sessions: [session],
			});
		else entry.sessions.push(session);
	}
	return [...known.values()];
};

const latestActivity = (repository: KnownRepository) =>
	repository.sessions.reduce(
		(latest, session) => Math.max(latest, session.updatedAt),
		Number.NEGATIVE_INFINITY,
	);

/** Most recently active first; repositories with no sessions trail, alphabetically. */
export const sortByActivity = <T extends KnownRepository>(
	repositories: ReadonlyArray<T>,
): ReadonlyArray<T> =>
	[...repositories].sort(
		(a, b) =>
			latestActivity(b) - latestActivity(a) ||
			repositoryKey(a.owner, a.repo).localeCompare(
				repositoryKey(b.owner, b.repo),
			),
	);

const diagnoseCheckout = (
	repository: Pick<KnownRepository, "owner" | "repo" | "path">,
): Effect.Effect<
	RepositoryProblem | null,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	repository.path === null
		? Effect.succeed("no-path")
		: verifyRepoPathMatchesOrigin(
				repository.path,
				repository.owner,
				repository.repo,
			).pipe(
				Effect.as(null),
				Effect.catchTags({
					RepoPathNotFound: () => Effect.succeed("path-missing" as const),
					RepoPathNotAGitRepo: () => Effect.succeed("not-a-git-repo" as const),
					RepoPathNoOriginRemote: () => Effect.succeed("no-origin" as const),
					RepoPathOriginMismatch: () =>
						Effect.succeed("origin-mismatch" as const),
				}),
			);

const readKnownRepositories = Effect.gen(function* () {
	const settings = yield* SettingsStore;
	const reviews = yield* ReviewStore;
	return collectRepositories(
		yield* settings.listRepoPaths(),
		yield* reviews.listPullRequestSessions(),
	);
});

/** No GitHub calls: `openCount` comes from the in-memory PR index alone. */
export const listRepositories: Effect.Effect<
	ReadonlyArray<RepositorySummary>,
	SettingsStoreError | ReviewStoreError | GitCommandError,
	| SettingsStore
	| ReviewStore
	| PrIndex
	| ChildProcessSpawner.ChildProcessSpawner
> = Effect.gen(function* () {
	const index = yield* PrIndex;
	const repositories = sortByActivity(yield* readKnownRepositories);
	return yield* Effect.forEach(
		repositories,
		(repository) =>
			Effect.gen(function* () {
				const problem = yield* diagnoseCheckout(repository);
				const open = yield* Effect.forEach(repository.sessions, (session) =>
					index.lookupPullRequest(
						repository.owner,
						repository.repo,
						session.number,
					),
				);
				return {
					owner: repository.owner,
					repo: repository.repo,
					path: repository.path,
					openCount: open.filter((found) => found !== undefined).length,
					sessionCount: repository.sessions.length,
					problem,
				};
			}),
		{ concurrency: 4 },
	);
});

const fromGitHub = (state: "OPEN" | "CLOSED" | "MERGED"): PrState =>
	state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed";

/**
 * Open per the PR index, else a persisted terminal state, else asked of
 * GitHub (once per PR number, 4 at a time) and persisted. A failed lookup
 * fails the whole call: a state nobody observed is worse than none.
 */
const resolveSessionStates = (
	owner: string,
	repo: string,
	sessions: ReadonlyArray<PullRequestSessionRecord>,
): Effect.Effect<
	ReadonlyArray<{ session: PullRequestSessionRecord; state: PrState }>,
	PullRequestStateError | GitCommandError | ReviewStoreError | SessionNotFound,
	GitHub | PrIndex | ReviewStore | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const github = yield* GitHub;
		const index = yield* PrIndex;
		const reviews = yield* ReviewStore;
		const known = new Map<string, PrState>();
		for (const session of sessions) {
			const inIndex = yield* index.lookupPullRequest(
				owner,
				repo,
				session.number,
			);
			if (inIndex !== undefined) known.set(session.id, "open");
			else if (session.prState === "merged" || session.prState === "closed")
				known.set(session.id, session.prState);
		}
		const unresolved = sessions.filter((session) => !known.has(session.id));
		const fetched = new Map(
			yield* Effect.forEach(
				[...new Set(unresolved.map((session) => session.number))],
				(number) =>
					github
						.pullRequestState(process.cwd(), owner, repo, number)
						.pipe(Effect.map((state) => [number, fromGitHub(state)] as const)),
				{ concurrency: 4 },
			),
		);
		for (const session of unresolved) {
			const state = fetched.get(session.number);
			if (state === undefined)
				return yield* Effect.die(
					new Error(`no state fetched for PR #${session.number}`),
				);
			known.set(session.id, state);
			if (session.prState !== state)
				yield* reviews.setPrState(session.id, state);
		}
		return yield* Effect.forEach(sessions, (session) => {
			const state = known.get(session.id);
			return state === undefined
				? Effect.die(new Error(`no state resolved for session ${session.id}`))
				: Effect.succeed({ session, state });
		});
	});

export const getRepository = (
	owner: string,
	repo: string,
): Effect.Effect<
	RepositoryDetail,
	| SettingsStoreError
	| ReviewStoreError
	| SessionNotFound
	| GitCommandError
	| PullRequestStateError,
	| SettingsStore
	| ReviewStore
	| PrIndex
	| GitHub
	| ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const key = repositoryKey(owner, repo);
		const known = (yield* readKnownRepositories).find(
			(candidate) => repositoryKey(candidate.owner, candidate.repo) === key,
		) ?? { owner, repo, path: null, sessions: [] };
		const problem = yield* diagnoseCheckout(known);
		// A checkout that exists as a git repo can still be asked for its origin
		// when the origin is merely the wrong one — that's what the user is fixing.
		const remoteUrl =
			known.path === null ||
			problem === "path-missing" ||
			problem === "not-a-git-repo"
				? null
				: yield* originUrlOrNull(known.path);
		const resolved = yield* resolveSessionStates(
			known.owner,
			known.repo,
			known.sessions,
		);
		return {
			owner: known.owner,
			repo: known.repo,
			path: known.path,
			remoteUrl,
			problem,
			sessions: resolved.map(({ session, state }) => ({
				id: session.id,
				prNumber: session.number,
				prTitle: session.title,
				state,
				updatedAt: session.updatedAt,
			})),
		};
	});
