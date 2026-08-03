import type { GenerateEvent, HarnessId } from "@repo/sidecar-api";

type GenerationStatus = "running" | "done" | "failed" | "cancelled";

type GenerationRecord = {
	readonly harness: HarnessId;
	readonly model: string | null;
	readonly events: Array<GenerateEvent>;
	status: GenerationStatus;
	readonly subscribers: Set<(event: GenerateEvent) => void>;
	/** Owned here rather than in a second map, since this module already tracks "is a generation running for this session" — see `abortGeneration`/`beginGeneration`. */
	readonly abortController: AbortController;
};

/**
 * One retained generation per session — a session only ever has one in
 * flight (the harness session itself refuses a second concurrent turn, see
 * `@ai-sdk/harness`'s `HarnessAgentSession`), so keying on `sessionId` alone
 * is enough. Gone on sidecar restart by design, same as `live-sessions.ts`'s
 * map: there's no live process left to reattach to after a restart anyway.
 */
const generations = new Map<string, GenerationRecord>();

const statusOf = (event: GenerateEvent): GenerationStatus =>
	event.type === "done" || event.type === "failed" || event.type === "cancelled"
		? event.type
		: "running";

/**
 * Starts tracking a new generation for `sessionId`, discarding whatever was
 * previously retained (a finished generation's log, or — defensively,
 * shouldn't happen — a still-"running" one). Call once, synchronously,
 * before the first `await` in whatever kicks the generation off: two
 * `generate` calls racing for the same session both check
 * `attachToGeneration` first, so as long as this runs before either yields
 * to the event loop, the second one always finds the record the first just
 * created and reattaches instead of starting a duplicate.
 *
 * `abortController` is minted by the caller (`generate.ts`'s
 * `beginTrackedGeneration`), which also threads its `signal` into the
 * generation loop — this module only retains it so `abortGeneration` can
 * reach it by `sessionId` later, from a separate `walkthrough.stop` request
 * that has no other handle on the loop in progress.
 */
export const beginGeneration = (
	sessionId: string,
	harness: HarnessId,
	model: string | undefined,
	abortController: AbortController,
): void => {
	generations.set(sessionId, {
		harness,
		model: model ?? null,
		events: [],
		status: "running",
		subscribers: new Set(),
		abortController,
	});
};

/**
 * Aborts the generation retained for `sessionId`, if any — a no-op, not an
 * error, when nothing's running for it (already finished, or never
 * started). Only signals the abort; the generation loop itself is what
 * observes it and yields the terminal `cancelled` event, so this returns
 * before that happens.
 */
export const abortGeneration = (sessionId: string): void => {
	const record = generations.get(sessionId);
	if (record === undefined || record.status !== "running") return;
	record.abortController.abort();
};

/** Discards a session's retained generation — used when starting one turns out to have failed before anything worth keeping was recorded (e.g. the session itself doesn't exist). */
export const clearGeneration = (sessionId: string): void => {
	generations.delete(sessionId);
};

/** Appends an event to the retained log and fans it out to every attached subscriber, synchronously — see `attachToGeneration` for why that matters. */
export const recordGenerationEvent = (
	sessionId: string,
	event: GenerateEvent,
): void => {
	const record = generations.get(sessionId);
	if (record === undefined) return;
	record.events.push(event);
	record.status = statusOf(event);
	for (const subscriber of record.subscribers) subscriber(event);
};

export type GenerationSnapshot = {
	readonly harness: HarnessId;
	readonly model: string | null;
	readonly events: ReadonlyArray<GenerateEvent>;
	readonly status: GenerationStatus;
};

/** `undefined` when nothing is retained for this session — never started, or overwritten by a newer generation. Unlike `attachToGeneration`, this includes finished (`"done"`/`"failed"`) generations — it's a pure read for `walkthrough.activeGeneration`, not a decision about whether to reattach. */
export const getGeneration = (
	sessionId: string,
): GenerationSnapshot | undefined => {
	const record = generations.get(sessionId);
	if (record === undefined) return undefined;
	return {
		harness: record.harness,
		model: record.model,
		events: record.events,
		status: record.status,
	};
};

/**
 * Attaches a subscriber to a generation that's still `"running"` for
 * `sessionId`: replays every event retained so far into `onEvent`, then
 * subscribes it for live ones, and returns the unsubscribe function. Returns
 * `undefined` — nothing to attach to — both when no generation is retained
 * at all *and* when the retained one already finished, so a fresh `generate`
 * call for a session with a completed/failed log correctly starts a new
 * generation instead of replaying the stale result as if it were live.
 *
 * Replay and subscription happen back to back with no `await` in between, so
 * nothing recorded after this call returns can be missed by the live
 * subscription, and nothing already retained can be double-delivered —
 * `recordGenerationEvent` can only ever run on its own turn of the event
 * loop, never interleaved inside this function's body.
 */
export const attachToGeneration = (
	sessionId: string,
	onEvent: (event: GenerateEvent) => void,
): (() => void) | undefined => {
	const record = generations.get(sessionId);
	if (record === undefined || record.status !== "running") return undefined;
	for (const event of record.events) onEvent(event);
	record.subscribers.add(onEvent);
	return () => {
		record.subscribers.delete(onEvent);
	};
};
