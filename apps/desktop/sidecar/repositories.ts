import {
	type GitCommandError,
	GitHub,
	originUrlOrNull,
	type PullRequestStateError,
	type PullRequestStatesError,
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
	RepositorySession,
	RepositorySessionStateBatch,
	RepositorySummary,
} from "@repo/sidecar-api";
import { Effect, Stream } from "effect";
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

const describeStateFailure = (
	error: PullRequestStateError | PullRequestStatesError | GitCommandError,
): string => {
	switch (error._tag) {
		case "GhNotAuthenticated":
			return `gh is not authenticated: ${error.reason}`;
		case "GhRateLimited":
			return `GitHub is rate-limiting this account: ${error.reason}`;
		case "GhOutputDecodeError":
			return `gh returned output nisi couldn't parse (${error.command})`;
		case "PullRequestNotFound":
			return error.reason === ""
				? "GitHub could not return this pull request"
				: error.reason;
		case "GitHubUnreachable":
			return `GitHub could not be reached: ${error.reason}`;
		case "GitCommandError":
			return `${error.command} could not be run: ${error.stderr || String(error.cause)}`;
	}
};

type ResolvedState = Extract<
	RepositorySession["state"],
	{ readonly kind: "resolved" }
>;

/** Open per the PR index, else a persisted terminal state; `null` when only GitHub can say. A persisted `open` is stale by definition, so it doesn't count. */
const knownState = (
	owner: string,
	repo: string,
	session: PullRequestSessionRecord,
): Effect.Effect<ResolvedState | null, never, PrIndex> =>
	Effect.gen(function* () {
		const index = yield* PrIndex;
		const inIndex = yield* index.lookupPullRequest(owner, repo, session.number);
		if (inIndex !== undefined) return { kind: "resolved", state: "open" };
		return session.prState === "merged" || session.prState === "closed"
			? { kind: "resolved", state: session.prState }
			: null;
	});

/**
 * Streams the PR states `getRepository` left `pending`, each persisted
 * before it is yielded so a client that goes away keeps the work done so far.
 * One `gh pr list` answers most of them as the first event; the rest, which
 * that listing didn't return, are looked up one `gh pr view` at a time (4 at
 * once) and yielded as each lands. A failed lookup is yielded `unresolved`
 * and persists nothing. Account-wide failures (not authenticated,
 * rate-limited) fail the listing for every PR identically, so they're
 * reported for all of them at once instead of retried per PR.
 */
export const streamSessionStates = (
	owner: string,
	repo: string,
): Stream.Stream<
	RepositorySessionStateBatch,
	ReviewStoreError | SessionNotFound,
	GitHub | PrIndex | ReviewStore | ChildProcessSpawner.ChildProcessSpawner
> =>
	Stream.unwrap(
		Effect.gen(function* () {
			const github = yield* GitHub;
			const reviews = yield* ReviewStore;
			const cwd = process.cwd();
			const sessionsByNumber = new Map<number, PullRequestSessionRecord[]>();
			for (const session of yield* reviews.listPullRequestSessions({
				owner,
				repo,
			})) {
				if ((yield* knownState(owner, repo, session)) !== null) continue;
				const sharing = sessionsByNumber.get(session.number);
				if (sharing === undefined)
					sessionsByNumber.set(session.number, [session]);
				else sharing.push(session);
			}
			const pending = [...sessionsByNumber.keys()];
			if (pending.length === 0) return Stream.empty;

			const persist = (number: number, state: PrState) =>
				Effect.forEach(sessionsByNumber.get(number) ?? [], (session) =>
					session.prState === state
						? Effect.void
						: reviews.setPrState(session.id, state),
				);
			const unresolved = (
				number: number,
				error: PullRequestStateError | PullRequestStatesError | GitCommandError,
			) => ({
				prNumber: number,
				state: {
					kind: "unresolved" as const,
					reason: describeStateFailure(error),
				},
			});
			const lookUp = (number: number) =>
				github.pullRequestState(cwd, owner, repo, number).pipe(
					Effect.tapError((error) =>
						Effect.logWarning("Could not read a pull request's state", {
							owner,
							repo,
							number,
							error,
						}),
					),
					Effect.matchEffect({
						onFailure: (error) => Effect.succeed([unresolved(number, error)]),
						onSuccess: (state) =>
							persist(number, fromGitHub(state)).pipe(
								Effect.as([
									{
										prNumber: number,
										state: {
											kind: "resolved" as const,
											state: fromGitHub(state),
										},
									},
								]),
							),
					}),
				);
			const lookUpEach = (numbers: ReadonlyArray<number>) =>
				Stream.fromIterable(numbers).pipe(
					Stream.mapEffect(lookUp, { concurrency: 4, unordered: true }),
				);

			const listing = yield* github.pullRequestStates(cwd, owner, repo).pipe(
				Effect.tapError((error) =>
					Effect.logWarning(
						"Could not list a repository's pull request states",
						{
							owner,
							repo,
							error,
						},
					),
				),
				Effect.match({
					onFailure: (error) => ({ listed: false as const, error }),
					onSuccess: (states) => ({ listed: true as const, states }),
				}),
			);
			if (!listing.listed) {
				const error = listing.error;
				return error._tag === "GhNotAuthenticated" ||
					error._tag === "GhRateLimited"
					? Stream.make(pending.map((number) => unresolved(number, error)))
					: lookUpEach(pending);
			}

			const listed = new Map(
				listing.states.map((entry) => [entry.number, entry.state]),
			);
			const answered = pending.flatMap((number) => {
				const state = listed.get(number);
				return state === undefined
					? []
					: [{ number, state: fromGitHub(state) }];
			});
			yield* Effect.forEach(answered, (entry) =>
				persist(entry.number, entry.state),
			);
			const answeredNumbers = new Set(answered.map((entry) => entry.number));
			return Stream.concat(
				answered.length === 0
					? Stream.empty
					: Stream.make(
							answered.map((entry) => ({
								prNumber: entry.number,
								state: { kind: "resolved" as const, state: entry.state },
							})),
						),
				lookUpEach(pending.filter((number) => !answeredNumbers.has(number))),
			);
		}),
	);

export const getRepository = (
	owner: string,
	repo: string,
): Effect.Effect<
	RepositoryDetail,
	SettingsStoreError | ReviewStoreError | GitCommandError,
	| SettingsStore
	| ReviewStore
	| PrIndex
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
		const sessions = yield* Effect.forEach(known.sessions, (session) =>
			knownState(known.owner, known.repo, session).pipe(
				Effect.map((state) => ({
					id: session.id,
					prNumber: session.number,
					prTitle: session.title,
					state: state ?? ({ kind: "pending" } as const),
					updatedAt: session.updatedAt,
				})),
			),
		);
		return {
			owner: known.owner,
			repo: known.repo,
			path: known.path,
			remoteUrl,
			problem,
			sessions,
		};
	});
