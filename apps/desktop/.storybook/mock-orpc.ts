/**
 * A fake `SidecarClient` for stories — `createTanstackQueryUtils` only cares
 * whether a leaf is a function (see `@orpc/tanstack-query`'s
 * `createRouterUtilsInternal`), not whether it came from a real network
 * link, so a plain nested object of async functions produces the exact same
 * `queryOptions`/`mutationOptions`/`queryKey`/`call` surface
 * `backend-context.tsx`'s real `createTanstackQueryUtils(makeSidecarClient(...))`
 * does — no separate mock of `ProcedureUtils` needed. Typed against
 * `SidecarClient` itself (not a hand-rolled subset) so every procedure a
 * story might reach stays wired up and future contract changes surface here
 * as a type error instead of a silent gap.
 *
 * Generic story infra, not walkthrough-specific — `createMockOrpc`'s
 * parameters are the handful of things any story actually varies
 * (`storedWalkthrough`, `harnesses`, `settings`, `fileContents`,
 * `runningGeneration`); the walkthrough content itself (sections, reference
 * blocks, file patches) lives in `walkthrough.fixture.ts`.
 */
import { AsyncIteratorClass } from "@orpc/shared";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
	CODE_INDEX_SOURCE_CONTEXT_LINES_AFTER,
	CODE_INDEX_SOURCE_CONTEXT_LINES_BEFORE,
	type CodeIndexReferencesResult,
	type GuideResult,
	type PushEvent,
	type RepositoryDetail,
	type RepositorySessionStateBatch,
	type RepositorySummary,
	type SidecarClient,
	type UnpushedCommits,
} from "@repo/sidecar-api";
import type {
	FileChange,
	FileContent,
	PullRequestCheck,
	PullRequestMergeStatus,
	PullRequestStack,
	PullRequestStackSuggestion,
} from "#/features/pull-request/data/pr-data";
import type {
	PullRequestRepository,
	PullRequestSearchResult,
} from "#/features/pull-request/data/pull-requests-data";
import type {
	GenerateEvent,
	HarnessId,
	HarnessInfo,
	HarnessModels,
	StoredWalkthrough,
} from "#/features/pull-request/walkthrough/walkthrough-data";
import type { Settings } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";

const DEFAULT_SETTINGS: Settings = {
	enabledHarnesses: ["claude-code", "codex"],
	sidebarViewMode: "tree",
	diffStyleMode: "unified",
	preferredEditor: null,
	hideReviewed: false,
	includeUncommitted: false,
	// Stories exercise the walkthrough tab/harness panels, which are gated on
	// this setting — on by default here so existing stories don't need to
	// override it just to keep rendering what they already render.
	walkthroughEnabled: true,
	notificationsEnabled: false,
	notifyScheduledMergeSettled: true,
	wrapLines: false,
	lastChatHarness: null,
	lastChatModel: null,
	diffThemeLight: "github-light",
	diffThemeDark: "github-dark",
};

/** A plausible four-harness registry — two enabled+available, one enabled but missing, one disabled. */
const DEFAULT_HARNESSES: readonly HarnessInfo[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		enabled: true,
		available: true,
		binaryPath: "/usr/local/bin/claude",
	},
	{
		id: "codex",
		label: "Codex",
		enabled: true,
		available: true,
		binaryPath: "/usr/local/bin/codex",
	},
	{
		id: "opencode",
		label: "opencode",
		enabled: true,
		available: false,
		binaryPath: null,
	},
	{
		id: "pi",
		label: "Pi",
		enabled: false,
		available: true,
		binaryPath: null,
	},
];

const DEFAULT_MODELS: Record<HarnessId, HarnessModels> = {
	"claude-code": {
		models: [
			{ id: "claude-opus-4-5", label: "Claude Opus 4.5" },
			{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
		],
		status: "fresh",
	},
	codex: {
		models: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }],
		status: "fresh",
	},
	opencode: { models: [], status: "unavailable" },
	pi: { models: [], status: "unavailable" },
};

/** A fixture, or the query staying pending forever, or rejecting with this message. */
export type MockResult<T> = T | { pending: true } | { error: string };

function settleMockResult<T>(result: MockResult<T> | undefined): Promise<T> {
	if (result === undefined) return neverSettles();
	if (typeof result === "object" && result !== null) {
		if ("pending" in result) return neverSettles();
		if ("error" in result) return Promise.reject(new Error(result.error));
	}
	return Promise.resolve(result);
}

export type MockOrpcData = {
	files?: readonly FileChange[];
	filesDelayMs?: number;
	/** How many `pullRequests.search` calls resolve before every later one stays pending forever — omit for all of them to resolve. `0` keeps even the first search in flight; `1` gives one loaded result set that any refetch then leaves revalidating. */
	pullRequestSearchSettleLimit?: number;
	/** `pullRequests.search`'s rows; `pullRequests.indexed` lists the open ones too, each with a made-up head branch. */
	pullRequestSearchResults?: readonly PullRequestSearchResult[];
	pullRequestRepositories?: readonly PullRequestRepository[];
	/** `repositories.list`'s result. */
	repositories?: MockResult<readonly RepositorySummary[]>;
	/** `repositories.get`'s result, whichever `owner/repo` is asked for — omit to leave it pending forever. */
	repositoryDetail?: MockResult<RepositoryDetail>;
	/** `repositories.sessionStates`'s events, each yielded `delayMs` after the previous one — omit for a stream that ends at once, i.e. nothing was pending. */
	repositorySessionStates?: {
		events: readonly {
			delayMs: number;
			batch: RepositorySessionStateBatch;
		}[];
		/** After the last event: `end` (the default) completes the stream, `hang` leaves it open so the story stays mid-resolution, `{ error }` fails it. */
		afterEvents?: "end" | "hang" | { error: string };
	};
	/** `codeIndex.references`'s result, whichever symbol is asked for — omit to leave it pending forever. */
	codeIndexReferences?: MockResult<CodeIndexReferencesResult>;
	/** `codeIndex.referenceContext` slices the asked-for window out of these files' lines (keyed by path); `pending` leaves every context fetch hanging. */
	codeIndexFileLines?: Readonly<Record<string, readonly string[]>> | "pending";
	/** `walkthrough.get`'s result — omit for "nothing generated yet", pass a fixture for the loaded reader. */
	storedWalkthrough?: StoredWalkthrough | null;
	/** `guide.get`'s result — omit for "no guide written yet". */
	guide?: GuideResult;
	/** Overrides `DEFAULT_HARNESSES` wholesale — pass a full four-entry list, not a patch. */
	harnesses?: readonly HarnessInfo[];
	models?: Partial<Record<HarnessId, HarnessModels>>;
	/** Merged over `DEFAULT_SETTINGS`. */
	settings?: Partial<Settings>;
	/** `diff.fileContents`' per-path results — keyed by the same paths the story's `files` prop uses. A path with no entry here reports `content: null` ("not part of the current diff"), same as the real sidecar. */
	fileContents?: Readonly<Record<string, FileContent>>;
	/** `pullRequests.mergeStatus`'s result — omit to leave the mock pending forever (`neverSettles`), same as before this field existed. */
	mergeStatus?: PullRequestMergeStatus;
	scheduledMerge?: { method: "merge" | "squash" | "rebase" } | null;
	/** `pullRequests.unpushedCommits`'s result until a `pushBranch` call streams `done`; every check after that reports a clean branch, as the real sidecar would. */
	unpushedCommits?: UnpushedCommits;
	/** What each `pullRequests.pushBranch` call streams, one event every `PUSH_EVENT_DELAY_MS`. Omit for a call that never produces anything. */
	pushBranch?: (input: { rebase: boolean }) => readonly PushEvent[];
	/** When set, `pullRequests.mergeStatus` rejects with this message instead of resolving — covers the "query failed and never once succeeded" case. Takes priority over `mergeStatus` if both are set (they shouldn't be). */
	mergeStatusError?: string;
	/** `pullRequests.stack`'s result — omit to leave the mock pending forever. */
	stack?: PullRequestStack | null;
	/** `pullRequests.stackSuggestion`'s result — omit to leave the mock pending forever. */
	stackSuggestion?: PullRequestStackSuggestion | null;
	/** `pullRequests.checks`'s result — omit to leave the mock pending forever (`neverSettles`), same as `mergeStatus`. */
	checks?: readonly PullRequestCheck[];
	/** When set, `pullRequests.checks` rejects with this message instead of resolving. Takes priority over `checks` if both are set (they shouldn't be). */
	checksError?: string;
	/** Successful approval replaces awaiting runs with queued checks on the next query. */
	approveWorkflowRuns?: (runIds: readonly number[]) => void;
	/**
	 * When set, `walkthrough.activeGeneration` reports a `"running"`
	 * generation and `walkthrough.generate` replays `events` in order (each a
	 * tick apart) and then hangs — never emitting a terminal `done`/`failed`
	 * — so `useWalkthroughGeneration`'s reattach path drives the tree straight
	 * into `GenerationTimeline` on mount, no click required, and the story
	 * stays parked there for design iteration instead of finishing.
	 */
	runningGeneration?: {
		harness: HarnessId;
		model: string | null;
		events: readonly GenerateEvent[];
	};
};

function neverSettles(): Promise<never> {
	return new Promise<never>(() => {});
}

/**
 * `walkthrough.generate`/`events.subscribe`'s real client return type is
 * `@orpc/shared`'s `AsyncIteratorClass`, not a bare `AsyncGenerator` — a
 * plain `async function*` structurally implements the iterator protocol but
 * fails the exact contract type (`isDone`/`isExecuteComplete`/`cleanup` are
 * private fields, not just an interface shape). Wrapping the generator's
 * `next()` is the least-code way to produce a real instance rather than
 * hand-rolling the class.
 */
function toAsyncIteratorClass<T>(
	source: AsyncGenerator<T, void, unknown>,
): AsyncIteratorClass<T, void> {
	return new AsyncIteratorClass<T, void>(
		() => source.next(),
		async () => undefined,
	);
}

/** An iterator that never produces a value — `events.subscribe`'s stub (never read by the walkthrough tree) and `walkthrough.generate`'s stub when no `runningGeneration` was configured. */
function neverIterator<T>(): AsyncIteratorClass<T, void> {
	return new AsyncIteratorClass<T, void>(
		() => neverSettles(),
		async () => undefined,
	);
}

async function* replayRepositorySessionStates(
	stream: NonNullable<MockOrpcData["repositorySessionStates"]>,
): AsyncGenerator<RepositorySessionStateBatch> {
	for (const event of stream.events) {
		await new Promise((resolve) => setTimeout(resolve, event.delayMs));
		yield event.batch;
	}
	if (stream.afterEvents === "hang") await neverSettles();
	if (typeof stream.afterEvents === "object")
		throw new Error(stream.afterEvents.error);
}

function liveValue<T>(value: T): AsyncIteratorClass<T, void> {
	return toAsyncIteratorClass(
		(async function* () {
			yield value;
			await neverSettles();
		})(),
	);
}

const PUSH_EVENT_DELAY_MS = 250;

async function* replayPush(
	events: readonly PushEvent[],
	onDone: () => void,
): AsyncGenerator<PushEvent> {
	for (const event of events) {
		await new Promise((resolve) => setTimeout(resolve, PUSH_EVENT_DELAY_MS));
		if (event.type === "done") onDone();
		yield event;
	}
}

async function* replayThenHang(
	events: readonly GenerateEvent[],
): AsyncGenerator<GenerateEvent> {
	for (const event of events) {
		// A tick between events so a story's timeline visibly builds up rather
		// than appearing fully formed on the first render.
		await new Promise((resolve) => setTimeout(resolve, 400));
		yield event;
	}
	await neverSettles();
}

/** Builds a fake `SidecarClient` and wraps it in the same `createTanstackQueryUtils` the real app uses — see this module's doc comment. */
export function createMockSidecarClient(
	data: MockOrpcData = {},
): SidecarClient {
	const settings: Settings = { ...DEFAULT_SETTINGS, ...data.settings };
	const harnesses = data.harnesses ?? DEFAULT_HARNESSES;
	const fileContents = data.fileContents ?? {};
	const runningGeneration = data.runningGeneration;
	const mergeStatus = data.mergeStatus;
	let branchPushed = false;
	const scheduledMergeState = {
		request: data.scheduledMerge === undefined ? null : data.scheduledMerge,
	};
	const mergeStatusError = data.mergeStatusError;
	let searchCalls = 0;
	const stack = data.stack;
	const stackSuggestion = data.stackSuggestion;
	const checks = data.checks;
	const approvedRuns = new Set<number>();
	const checksError = data.checksError;

	const client: SidecarClient = {
		diagnostics: {
			launchMarks: async () => {},
			injectDeepLink: async () => {
				throw new Error("Deep-link measurement is unavailable in Storybook");
			},
			ackDeepLink: async () => {
				throw new Error("Deep-link measurement is unavailable in Storybook");
			},
			runWorkloadStep: async () => {
				throw new Error("Workload measurement is unavailable in Storybook");
			},
			ackWorkloadStep: async () => {
				throw new Error("Workload measurement is unavailable in Storybook");
			},
			workloadStepStatus: async () => {
				throw new Error("Workload measurement is unavailable in Storybook");
			},
			snapshot: async () => ({ sessions: [], rpcFailures: [] }),
		},
		health: {
			check: async () => ({ status: "ok" }),
		},
		sessions: {
			open: async ({ cwd }) => ({
				id: "storybook-session",
				repoRoot: cwd,
				target: { kind: "branch", baseRef: "main", headRef: "HEAD" },
			}),
			// No story exercises "Switch to PR" yet — same reasoning as
			// `chat.send`/`chat.closeThread` below.
			switchToPr: async ({ sessionId }) => ({
				id: sessionId,
				repoRoot: "/storybook",
				target: {
					kind: "pr",
					number: 1,
					title: "Storybook PR",
					baseRef: "main",
					headRef: "HEAD",
					owner: "storybook",
					repo: "storybook",
				},
			}),
			list: async () => [],
			close: async () => undefined,
			setWatching: async () => undefined,
			setAttention: async () => undefined,
		},
		events: {
			// Never resolves — the same "no events forthcoming" shape
			// `useLiveFileChanges`/`useSessions`/`usePullRequestChecks`'s
			// `useAwaitingNewCi` all treat as the steady state.
			subscribe: async () => neverIterator(),
			openRequests: async () => [],
			ackOpenRequest: async () => undefined,
		},
		// No story exercises the chat dock yet (Phase 3/4 frontend work) — these
		// stubs exist only to keep `SidecarClient` satisfied, same reasoning as
		// `events.subscribe` above.
		chat: {
			send: async () => neverIterator(),
			closeThread: async () => undefined,
		},
		diff: {
			files: async () => {
				if (data.filesDelayMs !== undefined)
					await new Promise((resolve) =>
						setTimeout(resolve, data.filesDelayMs),
					);
				return { files: [...(data.files ?? [])], baseMayBeStale: false };
			},
			refreshBase: async () => {
				throw new Error("diff.refreshBase has no story fixture yet");
			},
			fileContents: async ({ paths }) =>
				paths.map((request) => ({
					path: request.path,
					content: fileContents[request.path] ?? null,
				})),
		},
		// No story exercises the file-viewer tabs yet — same "keep
		// `SidecarClient` satisfied" reasoning as `chat` above.
		file: {
			get: async () => {
				throw new Error("file.get has no story fixture yet");
			},
		},
		guide: {
			get: async (): Promise<GuideResult> =>
				data.guide ?? {
					kind: "missing",
					path: "/repo/.nisi/guide/guide.mdx",
				},
			setWatching: async () => undefined,
			// Only the `nisi guide` CLI calls these; no story does.
			validate: async () => {
				throw new Error("guide.validate has no story fixture");
			},
			preview: async () => {
				throw new Error("guide.preview has no story fixture");
			},
		},
		review: {
			setViewed: async () => undefined,
			setRangeViewed: async () => undefined,
		},
		settings: {
			get: async () => settings,
			update: async (patch) => Object.assign(settings, patch),
		},
		// No story exercises the update pill yet — `unsupported` is what a
		// non-Homebrew install (i.e. every dev machine building Storybook)
		// actually reports, so this is the mock's honest default rather than
		// a placeholder.
		update: {
			status: async () => ({ type: "unsupported" }) as const,
			download: async () => undefined,
			restart: async () => undefined,
		},
		repositories: {
			list: () => settleMockResult(data.repositories ?? []),
			get: () => settleMockResult(data.repositoryDetail),
			sessionStates: async () =>
				toAsyncIteratorClass(
					replayRepositorySessionStates(
						data.repositorySessionStates ?? { events: [] },
					),
				),
		},
		pullRequests: {
			ciJob: neverSettles,
			rerunCiJob: neverSettles,
			repositories: async () => data.pullRequestRepositories ?? [],
			search: async (input) => {
				searchCalls += 1;
				if (
					data.pullRequestSearchSettleLimit !== undefined &&
					searchCalls > data.pullRequestSearchSettleLimit
				)
					return neverSettles();
				return (data.pullRequestSearchResults ?? []).filter(
					(pr) =>
						(input.repos.length === 0 ||
							input.repos.includes(`${pr.owner}/${pr.repo}`)) &&
						pr.title.toLowerCase().includes(input.query.toLowerCase()),
				);
			},
			indexed: async () => ({
				rows: (data.pullRequestSearchResults ?? [])
					.filter((pr) => pr.state === "OPEN")
					.map((pr) => ({
						owner: pr.owner,
						repo: pr.repo,
						number: pr.number,
						title: pr.title,
						author: pr.author,
						updatedAt: pr.updatedAt,
						url: pr.url,
						isDraft: pr.isDraft,
						state: pr.state,
						headRefName: `${pr.author}/${pr.repo}-${pr.number}`,
					})),
				incompleteRepos: [],
			}),
			open: neverSettles,
			recordRepoPath: async (input) => input,
			repointOrigin: neverSettles,
			mergeStatus:
				mergeStatusError !== undefined
					? async () => {
							throw new Error(mergeStatusError);
						}
					: mergeStatus === undefined
						? neverSettles
						: async () => liveValue(mergeStatus),
			stack:
				stack === undefined
					? async () => neverIterator()
					: async () => liveValue(stack),
			stackSuggestion:
				stackSuggestion === undefined
					? async () => neverIterator()
					: async () => liveValue(stackSuggestion),
			merge: async () => undefined,
			scheduleMerge: async (input) => {
				scheduledMergeState.request = { method: input.method };
			},
			cancelScheduledMerge: async () => {
				scheduledMergeState.request = null;
			},
			scheduledMerge: async () => scheduledMergeState.request,
			scheduledMerges: async () => [],
			mergeStack: async () => undefined,
			createStack: async () => undefined,
			markReady: async () => undefined,
			approveWorkflowRuns: async (input) => {
				data.approveWorkflowRuns?.(input.runIds);
				for (const id of input.runIds) approvedRuns.add(id);
			},
			checks:
				checksError !== undefined
					? async () => {
							throw new Error(checksError);
						}
					: checks === undefined
						? neverSettles
						: async () =>
								liveValue(
									checks.map((check) =>
										check.workflowRunId !== undefined &&
										approvedRuns.has(check.workflowRunId)
											? { ...check, status: "pending" as const }
											: check,
									),
								),
			unpushedCommits: async () =>
				data.unpushedCommits === undefined || branchPushed
					? {
							remoteRef: "origin/feature",
							ahead: 0,
							behind: 0,
							commits: [],
							diverged: false,
							origin: null,
						}
					: data.unpushedCommits,
			pushBranch: async (input) =>
				data.pushBranch === undefined
					? neverIterator()
					: toAsyncIteratorClass(
							replayPush(data.pushBranch(input), () => {
								branchPushed = true;
							}),
						),
		},
		// No story exercises the Overview tab yet — same reasoning as
		// `events.subscribe` above.
		overview: {
			get: async () => neverIterator(),
		},
		walkthrough: {
			harnesses: async () => harnesses,
			refreshHarnesses: async () => harnesses,
			models: async (input) =>
				data.models?.[input.harness] ?? DEFAULT_MODELS[input.harness],
			refreshModels: async (input) =>
				data.models?.[input.harness] ?? DEFAULT_MODELS[input.harness],
			get: async () => data.storedWalkthrough ?? null,
			activeGeneration: async () =>
				runningGeneration === undefined
					? null
					: {
							harness: runningGeneration.harness,
							model: runningGeneration.model,
							events: [...runningGeneration.events],
							status: "running",
						},
			generate: async () => {
				if (runningGeneration === undefined) return neverIterator();
				return toAsyncIteratorClass(replayThenHang(runningGeneration.events));
			},
			stop: async () => undefined,
		},
		// Only the peek-references dialog is covered; the LSP lifecycle and
		// per-file occurrences stay pending, same reasoning as `events.subscribe`.
		codeIndex: {
			lspStatus: neverSettles,
			startLsp: neverSettles,
			stopLsp: neverSettles,
			fileOccurrences: neverSettles,
			references: () => settleMockResult(data.codeIndexReferences),
			referenceContext: async ({ path, line }) => {
				const fileLines = data.codeIndexFileLines;
				if (fileLines === undefined || fileLines === "pending")
					return neverSettles();
				const lines = fileLines[path];
				if (lines === undefined) return null;
				const startLine = Math.max(
					0,
					line - CODE_INDEX_SOURCE_CONTEXT_LINES_BEFORE,
				);
				return {
					startLine,
					lines: lines.slice(
						startLine,
						line + CODE_INDEX_SOURCE_CONTEXT_LINES_AFTER + 1,
					),
				};
			},
		},
	};

	return client;
}

export function createMockOrpc(data: MockOrpcData = {}): SidecarQueryUtils {
	return createTanstackQueryUtils(createMockSidecarClient(data));
}
