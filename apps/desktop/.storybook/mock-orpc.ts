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
import type { SidecarClient } from "@repo/sidecar-api";
import type {
	FileContent,
	PullRequestCheck,
	PullRequestMergeStatus,
	PullRequestStack,
} from "#/features/pull-request/data/pr-data";
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

export type MockOrpcData = {
	/** `walkthrough.get`'s result — omit for "nothing generated yet", pass a fixture for the loaded reader. */
	storedWalkthrough?: StoredWalkthrough | null;
	/** Overrides `DEFAULT_HARNESSES` wholesale — pass a full four-entry list, not a patch. */
	harnesses?: readonly HarnessInfo[];
	models?: Partial<Record<HarnessId, HarnessModels>>;
	/** Merged over `DEFAULT_SETTINGS`. */
	settings?: Partial<Settings>;
	/** `diff.fileContents`' per-path results — keyed by the same paths the story's `files` prop uses. A path with no entry here reports `content: null` ("not part of the current diff"), same as the real sidecar. */
	fileContents?: Readonly<Record<string, FileContent>>;
	/** `pullRequests.mergeStatus`'s result — omit to leave the mock pending forever (`neverSettles`), same as before this field existed. */
	mergeStatus?: PullRequestMergeStatus;
	/** When set, `pullRequests.mergeStatus` rejects with this message instead of resolving — covers the "query failed and never once succeeded" case. Takes priority over `mergeStatus` if both are set (they shouldn't be). */
	mergeStatusError?: string;
	/** `pullRequests.stack`'s result — omit to leave the mock pending forever. */
	stack?: PullRequestStack | null;
	/** `pullRequests.checks`'s result — omit to leave the mock pending forever (`neverSettles`), same as `mergeStatus`. */
	checks?: readonly PullRequestCheck[];
	/** When set, `pullRequests.checks` rejects with this message instead of resolving. Takes priority over `checks` if both are set (they shouldn't be). */
	checksError?: string;
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
export function createMockOrpc(data: MockOrpcData = {}): SidecarQueryUtils {
	const settings: Settings = { ...DEFAULT_SETTINGS, ...data.settings };
	const harnesses = data.harnesses ?? DEFAULT_HARNESSES;
	const fileContents = data.fileContents ?? {};
	const runningGeneration = data.runningGeneration;
	const mergeStatus = data.mergeStatus;
	const mergeStatusError = data.mergeStatusError;
	const stack = data.stack;
	const checks = data.checks;
	const checksError = data.checksError;

	const client: SidecarClient = {
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
			files: async () => [],
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
		// `search`/`open`/`recordRepoPath` are never referenced by any story
		// yet — the open-PR palette has no storybook coverage — so those three
		// stubs exist only to keep `SidecarClient` satisfied, same reasoning as
		// `events.subscribe` above.
		pullRequests: {
			search: async () => [],
			open: neverSettles,
			recordRepoPath: neverSettles,
			mergeStatus:
				mergeStatusError !== undefined
					? async () => {
							throw new Error(mergeStatusError);
						}
					: mergeStatus === undefined
						? neverSettles
						: async () => mergeStatus,
			stack: stack === undefined ? neverSettles : async () => stack,
			merge: async () => undefined,
			mergeStack: async () => undefined,
			markReady: async () => undefined,
			checks:
				checksError !== undefined
					? async () => {
							throw new Error(checksError);
						}
					: checks === undefined
						? neverSettles
						: async () => checks,
			unpushedCommits: neverSettles,
		},
		// No story exercises the Overview tab yet — same reasoning as
		// `events.subscribe` above.
		overview: {
			get: neverSettles,
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
		// No story exercises go-to-definition/find-references yet — same
		// reasoning as `events.subscribe` above.
		codeIndex: {
			lspStatus: neverSettles,
			startLsp: neverSettles,
			stopLsp: neverSettles,
			fileOccurrences: neverSettles,
			references: neverSettles,
			referenceContext: neverSettles,
		},
	};

	return createTanstackQueryUtils(client);
}
