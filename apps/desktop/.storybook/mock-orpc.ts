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
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileContent } from "#/lib/pr-data";
import type { Settings } from "#/lib/settings-data";
import type {
	GenerateEvent,
	HarnessId,
	HarnessInfo,
	StoredWalkthrough,
} from "#/lib/walkthrough-data";

const DEFAULT_SETTINGS: Settings = {
	enabledHarnesses: ["claude-code", "codex"],
	sidebarViewMode: "tree",
	diffStyleMode: "unified",
	hideReviewed: false,
	includeUncommitted: false,
};

/** A plausible four-harness registry — two enabled+available with fresh models, one enabled but not found on `PATH`, one never turned on. Stories override individual entries (e.g. `EnableHarnessesPanel`'s onboarding gate wants every harness present but nothing enabled yet). */
const DEFAULT_HARNESSES: readonly HarnessInfo[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		enabled: true,
		available: true,
		modelsStatus: "fresh",
		binaryPath: "/usr/local/bin/claude",
		models: [
			{ id: "claude-opus-4-5", label: "Claude Opus 4.5" },
			{ id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
		],
	},
	{
		id: "codex",
		label: "Codex",
		enabled: true,
		available: true,
		modelsStatus: "fresh",
		binaryPath: "/usr/local/bin/codex",
		models: [{ id: "gpt-5.1-codex", label: "GPT-5.1 Codex" }],
	},
	{
		id: "opencode",
		label: "opencode",
		enabled: true,
		available: false,
		modelsStatus: "unavailable",
		binaryPath: null,
		models: [],
	},
	{
		id: "pi",
		label: "Pi",
		enabled: false,
		available: true,
		modelsStatus: "unavailable",
		binaryPath: null,
		models: [],
	},
];

export type MockOrpcData = {
	/** `walkthrough.get`'s result — omit for "nothing generated yet", pass a fixture for the loaded reader. */
	storedWalkthrough?: StoredWalkthrough | null;
	/** Overrides `DEFAULT_HARNESSES` wholesale — pass a full four-entry list, not a patch. */
	harnesses?: readonly HarnessInfo[];
	/** Merged over `DEFAULT_SETTINGS`. */
	settings?: Partial<Settings>;
	/** `diff.fileContents`' per-path results — keyed by the same paths the story's `files` prop uses. A path with no entry here reports `content: null` ("not part of the current diff"), same as the real sidecar. */
	fileContents?: Readonly<Record<string, FileContent>>;
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
			list: async () => [],
			close: async () => undefined,
			setWatching: async () => undefined,
		},
		events: {
			// Never referenced by the walkthrough tree's hooks.
			subscribe: async () => neverIterator(),
		},
		diff: {
			files: async () => [],
			fileContents: async ({ paths }) =>
				paths.map((request) => ({
					path: request.path,
					content: fileContents[request.path] ?? null,
				})),
		},
		review: {
			setViewed: async () => undefined,
			setRangeViewed: async () => undefined,
		},
		settings: {
			get: async () => settings,
			update: async (patch) => Object.assign(settings, patch),
		},
		// Never referenced by any story yet — the open-PR palette has no
		// storybook coverage — so these stubs exist only to keep `SidecarClient`
		// satisfied, same reasoning as `events.subscribe` above.
		pullRequests: {
			search: async () => [],
			open: neverSettles,
			recordRepoPath: neverSettles,
		},
		walkthrough: {
			harnesses: async () => harnesses,
			refreshHarnesses: async () => harnesses,
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
	};

	return createTanstackQueryUtils(client);
}
