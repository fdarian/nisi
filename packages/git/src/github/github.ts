import { Context, type Effect, type Stream } from "effect";
import type {
	GhOutputDecodeError,
	GitCommandError,
	GitHubUnreachable,
	PullRequestChecksError,
	PullRequestMergeabilityError,
	PullRequestMergeError,
	PullRequestNotFound,
	PullRequestReadyError,
	PullRequestSearchError,
	PullRequestStackMergeError,
	RepoMergeMethodsError,
} from "../errors.ts";
import type {
	PullRequestRef,
	PullRequestSearchResult,
} from "../pull-request.ts";
import type {
	FetchPullRequestChecksInput,
	FetchPullRequestOverviewInput,
	FetchPullRequestStackInput,
	MergeMethod,
	PullRequestCheck,
	PullRequestMergeability,
	PullRequestMergeStatus,
	PullRequestOverview,
	PullRequestStack,
	PullRequestStackError,
} from "./models.ts";

export type RepositoryIdentity = {
	readonly owner: string;
	readonly repo: string;
	readonly defaultBranch: string | null;
};

export type GitHubShape = {
	repository: (
		repoRoot: string,
	) => Effect.Effect<
		RepositoryIdentity | null,
		GitHubUnreachable | GhOutputDecodeError | GitCommandError
	>;
	pullRequest: (
		repoRoot: string,
		number?: number,
	) => Effect.Effect<
		PullRequestRef | null,
		PullRequestNotFound | GhOutputDecodeError | GitHubUnreachable
	>;
	headRef: (
		repoRoot: string,
		number: number,
	) => Effect.Effect<
		string,
		PullRequestNotFound | GhOutputDecodeError | GitCommandError
	>;
	search: (
		cwd: string,
		query: string,
	) => Effect.Effect<
		ReadonlyArray<PullRequestSearchResult>,
		PullRequestSearchError
	>;
	checks: (
		input: FetchPullRequestChecksInput,
	) => Effect.Effect<
		ReadonlyArray<PullRequestCheck>,
		PullRequestChecksError | GitCommandError
	>;
	overview: (
		input: FetchPullRequestOverviewInput,
	) => Effect.Effect<
		PullRequestOverview,
		PullRequestChecksError | GitCommandError
	>;
	stack: (
		input: FetchPullRequestStackInput,
	) => Effect.Effect<
		PullRequestStack | null,
		PullRequestStackError | GitCommandError
	>;
	mergeability: (
		repoRoot: string,
		number: number,
	) => Effect.Effect<
		PullRequestMergeability,
		PullRequestMergeabilityError | GitCommandError
	>;
	mergeMethods: (
		repoRoot: string,
		owner: string,
		repo: string,
	) => Effect.Effect<
		ReadonlyArray<MergeMethod>,
		RepoMergeMethodsError | GitCommandError
	>;
	merge: (
		repoRoot: string,
		owner: string,
		repo: string,
		number: number,
		method: MergeMethod,
	) => Effect.Effect<void, PullRequestMergeError | GitCommandError>;
	mergeStack: (
		repoRoot: string,
		owner: string,
		repo: string,
		number: number,
		method: MergeMethod,
	) => Effect.Effect<void, PullRequestStackMergeError | GitCommandError>;
	markReady: (
		repoRoot: string,
		owner: string,
		repo: string,
		number: number,
	) => Effect.Effect<void, PullRequestReadyError | GitCommandError>;
	watchChecks: (
		input: FetchPullRequestChecksInput,
	) => Stream.Stream<
		ReadonlyArray<PullRequestCheck>,
		PullRequestChecksError | GitCommandError
	>;
	watchMergeStatus: (
		input: FetchPullRequestChecksInput,
	) => Stream.Stream<
		PullRequestMergeStatus,
		PullRequestMergeabilityError | RepoMergeMethodsError | GitCommandError
	>;
	watchStack: (
		input: FetchPullRequestStackInput,
	) => Stream.Stream<
		PullRequestStack | null,
		PullRequestStackError | GitCommandError
	>;
	watchOverview: (
		input: FetchPullRequestOverviewInput,
	) => Stream.Stream<
		PullRequestOverview,
		PullRequestChecksError | GitCommandError
	>;
};

export class GitHub extends Context.Service<GitHub, GitHubShape>()(
	"git/github",
) {}
