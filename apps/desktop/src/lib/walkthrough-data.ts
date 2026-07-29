/**
 * Phase 3's walkthrough domain — harness/model discovery, the stored
 * walkthrough itself, its `generate` progress stream, and drift against the
 * live diff. Kept separate from `pr-data.ts` (the git/review domain) the
 * same way `@repo/walkthrough` is its own package: different lifecycle,
 * different consumers, and `pr-data.ts` is already sizeable.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileChange } from "#/lib/pr-data";

export type HarnessId = "claude-code" | "codex" | "opencode" | "pi";

export type HarnessModel = { id: string; label: string };

/**
 * Mirrors `ModelsStatus` (`packages/sidecar-api/src/walkthrough.ts`):
 * `"fresh"` — discovered (or cache-hit) this call; `"stale"` — the live
 * attempt failed but a previous successful discovery is being reused;
 * `"unavailable"` — discovery has never once succeeded, so `models` is
 * empty. Surfaced in the UI (`GeneratePanel`) so an empty model list reads
 * as "couldn't reach the CLI" rather than the generic "no search results"
 * a bare empty `models` array would otherwise look like.
 */
export type ModelsStatus = "fresh" | "stale" | "unavailable";

/**
 * Mirrors `HarnessInfo` (`packages/sidecar-api/src/walkthrough.ts`).
 * `walkthrough.harnesses()` always reports all four adapters — the
 * onboarding picker and the settings page's checkboxes both render every
 * entry `useHarnesses` returns rather than a separate static list.
 *
 * `available` and `enabled` are independent: `available` is a live
 * `@repo/bin-resolver` presence check (is the CLI actually on disk right
 * now — Pi has none, and is always available), `enabled` reflects
 * `@repo/settings`'s `enabledHarnesses` (unset counts as every harness
 * enabled) — a user declaration, not a probe. `binaryPath` is the resolved
 * path when `available`, for showing *which* binary was picked; `null`
 * otherwise. `models` is discovered live only for a harness that's both
 * enabled and available (each independently timeout-bounded and cached
 * server-side) — `modelsStatus` distinguishes "discovery succeeded with
 * zero models" from "discovery failed" from "not installed," since all
 * three otherwise look like the same empty array here.
 */
export type HarnessInfo = {
	id: HarnessId;
	label: string;
	models: readonly HarnessModel[];
	enabled: boolean;
	modelsStatus: ModelsStatus;
	available: boolean;
	binaryPath: string | null;
};

/** Mirrors `Location` (`packages/walkthrough/src/schema.ts`) — 1-based inclusive, in the file's head content. */
export type WalkthroughLocation = {
	path: string;
	startLine: number;
	endLine: number;
};

export type WalkthroughReferenceBlock = {
	id: string;
	label: string;
	locations: readonly WalkthroughLocation[];
};

export type WalkthroughSection = { title: string; body: string };

export type Walkthrough = {
	version: 1;
	sections: readonly WalkthroughSection[];
	references: readonly WalkthroughReferenceBlock[];
};

/** Mirrors `StoredWalkthrough` — `fingerprints` is the file-path → `FileChange.fingerprint` map captured at generation time, compared against the session's *current* fingerprints by `useWalkthroughDrift` below. */
export type StoredWalkthrough = {
	sessionId: string;
	harness: HarnessId;
	model: string | null;
	walkthrough: Walkthrough;
	fingerprints: Readonly<Record<string, string>>;
	generatedAt: number;
};

export type GenerateEvent =
	| { type: "bootstrapping" }
	| { type: "turn-started"; turn: number }
	| { type: "tool-call"; turn: number; toolName: string }
	| { type: "validation-failed"; turn: number; feedback: string }
	| { type: "retrying"; turn: number }
	| { type: "done"; walkthrough: StoredWalkthrough }
	| { type: "failed"; message: string };

/**
 * Mirrors `walkthrough.harnesses()` — the harness/model registry, live
 * `available` and cached `models` server-side. Never errors: every harness
 * is always reported, `available`/`enabled` decide what's selectable.
 *
 * `refresh()` calls `walkthrough.refreshHarnesses` directly (bypassing
 * `useQuery`'s own cache-then-fetch, same pattern as
 * `useWalkthroughGeneration`'s `orpc.walkthrough.generate.call(...)` below)
 * and writes the result straight into `harnesses`' query cache — so every
 * consumer of `useHarnesses` (the settings page, the onboarding panel, the
 * generate panel's combobox) updates from the same round trip regardless of
 * which one triggered it, without a second component-local cache to keep in
 * sync. `isRefreshing` is local to this hook instance, not shared across
 * mounts — fine in practice since the settings page and the walkthrough tab
 * are never both visible at once.
 */
export function useHarnesses(orpc: SidecarQueryUtils): {
	harnesses: readonly HarnessInfo[];
	isLoading: boolean;
	refresh: () => void;
	isRefreshing: boolean;
} {
	const queryClient = useQueryClient();
	const query = useQuery(orpc.walkthrough.harnesses.queryOptions());
	const mutation = useMutation({
		mutationFn: () => orpc.walkthrough.refreshHarnesses.call(),
		onSuccess: (harnesses) => {
			queryClient.setQueryData(
				orpc.walkthrough.harnesses.queryKey(),
				harnesses,
			);
		},
	});

	return {
		harnesses: query.data ?? [],
		isLoading: query.isLoading,
		refresh: mutation.mutate,
		isRefreshing: mutation.isPending,
	};
}

/** Mirrors `walkthrough.get({ sessionId })` — `undefined` while loading, `null` when the session has no generated walkthrough yet. */
export function useWalkthrough(
	orpc: SidecarQueryUtils,
	sessionId: string,
): { walkthrough: StoredWalkthrough | null | undefined; isLoading: boolean } {
	const query = useQuery(
		orpc.walkthrough.get.queryOptions({ input: { sessionId } }),
	);
	return { walkthrough: query.data, isLoading: query.isLoading };
}

type RunningStep =
	| { kind: "bootstrapping" }
	| { kind: "turn"; turn: number; toolName: string | null }
	| { kind: "validation-failed"; turn: number; feedback: string }
	| { kind: "retrying"; turn: number };

export type GenerationProgress =
	| { phase: "idle" }
	| { phase: "running"; step: RunningStep }
	| { phase: "failed"; message: string };

function reduceGenerateEvent(event: GenerateEvent): GenerationProgress {
	switch (event.type) {
		case "bootstrapping":
			return { phase: "running", step: { kind: "bootstrapping" } };
		case "turn-started":
			return {
				phase: "running",
				step: { kind: "turn", turn: event.turn, toolName: null },
			};
		case "tool-call":
			return {
				phase: "running",
				step: { kind: "turn", turn: event.turn, toolName: event.toolName },
			};
		case "validation-failed":
			return {
				phase: "running",
				step: {
					kind: "validation-failed",
					turn: event.turn,
					feedback: event.feedback,
				},
			};
		case "retrying":
			return {
				phase: "running",
				step: { kind: "retrying", turn: event.turn },
			};
		case "done":
			// The resulting `StoredWalkthrough` is already in `walkthrough.get`'s
			// cache by the time this fires (see `useWalkthroughGeneration` below)
			// — going back to "idle" is what hands control back to the reader.
			return { phase: "idle" };
		case "failed":
			return { phase: "failed", message: event.message };
	}
}

/** One `GenerateEvent` as it lands, tagged with a stable id for React keys — the stream can carry duplicate-shaped events (e.g. two `tool-call`s in the same turn), so the array index would be the only distinguishing key, which Biome's `noArrayIndexKey` (rightly) rejects. */
export type GenerationLogEntry = { id: number; event: GenerateEvent };

type GenerateRequest = { harness: HarnessId; model: string | undefined };

/**
 * Drives `walkthrough.generate`'s event stream. `.liveOptions()` replaces
 * `data` with each new chunk rather than accumulating (see
 * `@orpc/tanstack-query`'s `liveQuery`) — which isn't enough on its own for
 * a *complete* turn-by-turn log: `.liveOptions()` exposes only the latest
 * chunk as `query.data`, a single external value, not a queue. When two
 * events land in the same React commit (validation-failed immediately
 * followed by retrying, both yielded with no real `await` between them —
 * see `generate.ts`'s loop), a `useEffect` keyed on `query.data` only ever
 * observes the *last* of the two, silently dropping the other from the
 * timeline. So this consumes `orpc.walkthrough.generate.call(...)` directly
 * — the plain oRPC client call underneath the TanStack Query wrapper,
 * returning the raw async iterator — and pushes every event into `history`
 * from inside the `for await` loop itself. A functional `setHistory` update
 * queues correctly no matter how React batches the resulting renders, so
 * nothing yielded is ever missed. `progress` is folded in lockstep with the
 * same loop rather than derived from `history` afterward.
 *
 * On `done`, the resulting `StoredWalkthrough` is written straight into
 * `walkthrough.get`'s cache — no refetch needed, and the reader takes over
 * the instant `phase` goes back to `"idle"`.
 *
 * Regenerating with the *same* harness/model wouldn't otherwise re-trigger
 * the effect (its dependencies are unchanged) — `generate()` bumps `attempt`
 * in that case to force a fresh call. The sidecar itself decides whether to
 * resume the prior agent session or start fresh
 * (`apps/desktop/sidecar/walkthrough/generate.ts`'s `reuseLive` — same
 * harness/model as the live session resumes it).
 */
export function useWalkthroughGeneration(
	orpc: SidecarQueryUtils,
	sessionId: string,
): {
	progress: GenerationProgress;
	history: readonly GenerationLogEntry[];
	generate: (harness: HarnessId, model: string | undefined) => void;
} {
	const queryClient = useQueryClient();
	const [request, setRequest] = useState<GenerateRequest | null>(null);
	const [attempt, setAttempt] = useState(0);
	const [history, setHistory] = useState<readonly GenerationLogEntry[]>([]);
	const [progress, setProgress] = useState<GenerationProgress>({
		phase: "idle",
	});
	const requestRef = useRef(request);
	requestRef.current = request;
	const nextLogIdRef = useRef(0);

	// `attempt` isn't read in the body — it exists purely to force this effect
	// to re-run when `generate()` is called again with an unchanged `request`
	// (a same-harness/model Regenerate).
	// biome-ignore lint/correctness/useExhaustiveDependencies: see above
	useEffect(() => {
		if (request === null) return;

		let canceled = false;
		const controller = new AbortController();

		void (async () => {
			try {
				const stream = await orpc.walkthrough.generate.call(
					{ sessionId, harness: request.harness, model: request.model },
					{ signal: controller.signal },
				);
				for await (const event of stream) {
					if (canceled) return;
					const id = nextLogIdRef.current;
					nextLogIdRef.current += 1;
					setHistory((current) => [...current, { id, event }]);
					setProgress(reduceGenerateEvent(event));
					if (event.type === "done") {
						queryClient.setQueryData(
							orpc.walkthrough.get.queryKey({ input: { sessionId } }),
							event.walkthrough,
						);
					}
				}
			} catch (error) {
				if (canceled) return;
				setProgress({
					phase: "failed",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})();

		return () => {
			canceled = true;
			controller.abort();
		};
	}, [request, attempt, orpc, sessionId, queryClient]);

	const generate = useCallback(
		(harness: HarnessId, model: string | undefined) => {
			setHistory([]);
			setProgress({ phase: "idle" });
			const isSameRequest =
				requestRef.current?.harness === harness &&
				requestRef.current?.model === model;
			requestRef.current = { harness, model };
			setRequest({ harness, model });
			if (isSameRequest) setAttempt((current) => current + 1);
		},
		[],
	);

	return { progress, history, generate };
}

export type FileDrift = "new" | "edited" | "deleted";

export type WalkthroughDrift = {
	changedPaths: ReadonlyMap<string, FileDrift>;
	outdatedBlockIds: ReadonlySet<string>;
};

const NO_DRIFT: WalkthroughDrift = {
	changedPaths: new Map(),
	outdatedBlockIds: new Set(),
};

/**
 * Compares a stored walkthrough's generation-time fingerprints against the
 * session's *current* `diff.files` fingerprints — the same comparison
 * `FileChange.review.changedSinceReview` does for Phase 2, one layer up. A
 * reference block is outdated when any of its locations point at a path
 * that's since been edited or deleted; a brand-new path can't be referenced
 * by an existing block by construction, so it only ever shows up in
 * `changedPaths`, never `outdatedBlockIds`.
 */
export function useWalkthroughDrift(
	walkthrough: StoredWalkthrough | null | undefined,
	files: readonly FileChange[],
): WalkthroughDrift {
	return useMemo(() => {
		if (walkthrough == null) return NO_DRIFT;

		const currentFingerprints = new Map(
			files.map((file) => [file.path, file.fingerprint] as const),
		);
		const changedPaths = new Map<string, FileDrift>();

		for (const [path, fingerprint] of Object.entries(
			walkthrough.fingerprints,
		)) {
			const current = currentFingerprints.get(path);
			if (current === undefined) changedPaths.set(path, "deleted");
			else if (current !== fingerprint) changedPaths.set(path, "edited");
		}
		for (const file of files) {
			if (!(file.path in walkthrough.fingerprints)) {
				changedPaths.set(file.path, "new");
			}
		}

		const outdatedBlockIds = new Set<string>();
		for (const block of walkthrough.walkthrough.references) {
			const isOutdated = block.locations.some((location) => {
				const drift = changedPaths.get(location.path);
				return drift === "edited" || drift === "deleted";
			});
			if (isOutdated) outdatedBlockIds.add(block.id);
		}

		return { changedPaths, outdatedBlockIds };
	}, [walkthrough, files]);
}
