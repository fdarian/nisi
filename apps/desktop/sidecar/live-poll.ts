import {
	type RepoChangeSignature,
	readRepoChangeSignature,
	repoChangeSignatureEquals,
} from "@repo/git";
import { Duration, Effect, Schedule } from "effect";
import { emit } from "./events.ts";
import { Store } from "./store.ts";

/** How often each open session's repo is checked for changes since the last tick. */
export const POLL_INTERVAL = Duration.seconds(2);

/**
 * Previous poll's signature per session, keyed by the session's public id.
 * Module-level `Map`, not `Ref`-in-context: this state belongs to exactly
 * one thing (the single background poll loop started once at boot), the
 * same shape `events.ts`'s subscriber `Set` already uses for the sidecar's
 * other piece of long-lived in-memory state.
 */
const previousSignatures = new Map<string, RepoChangeSignature>();

/**
 * One poll tick: reads each open session's cheap change signature (HEAD sha
 * + mtime/size per touched path — never file content, see
 * `readRepoChangeSignature`) and emits `session-files-changed` for any
 * session whose signature moved since the last tick. A session's first tick
 * after opening never emits — there's nothing to compare against yet, and
 * the client already has fresh data from `sessions.open` itself.
 *
 * A transient git failure for one session (e.g. a rebase mid-flight) is
 * swallowed rather than failing the whole tick — the next tick tries again,
 * and one session's hiccup shouldn't stop every other open session from
 * being polled.
 */
const pollOnce = Effect.gen(function* () {
	const store = yield* Store;
	const sessions = yield* store.listSessions();

	yield* Effect.forEach(
		sessions,
		(session) =>
			readRepoChangeSignature(session.repoRoot).pipe(
				Effect.tap((signature) =>
					Effect.sync(() => {
						const previous = previousSignatures.get(session.id);
						previousSignatures.set(session.id, signature);
						if (
							previous !== undefined &&
							!repoChangeSignatureEquals(previous, signature)
						) {
							emit({ type: "session-files-changed", sessionId: session.id });
						}
					}),
				),
				Effect.orElseSucceed(() => undefined),
			),
		{ concurrency: "unbounded" },
	);

	// Drop signatures for sessions that closed since the last tick, so this
	// map doesn't grow for the lifetime of a long-running sidecar process.
	const openIds = new Set(sessions.map((session) => session.id));
	for (const id of previousSignatures.keys()) {
		if (!openIds.has(id)) previousSignatures.delete(id);
	}
});

/** Forks the poll loop as a background fiber tied to the caller's scope. */
export const startLivePolling = () =>
	pollOnce.pipe(
		Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
		Effect.asVoid,
		Effect.forkScoped,
	);
