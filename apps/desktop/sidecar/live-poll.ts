import {
	type RepoChangeSignature,
	readRepoChangeSignature,
	repoChangeSignatureEquals,
} from "@repo/git";
import { SettingsStore } from "@repo/settings";
import { Duration, Effect, Schedule } from "effect";
import { emit } from "./events.ts";
import { SessionWatch } from "./session-watch.ts";
import type { Session } from "./store.ts";
import { Store } from "./store.ts";

/** How often each watched session's repo is checked for changes since the last tick. */
export const POLL_INTERVAL = Duration.seconds(2);

/**
 * A stored signature plus the `includeUncommitted` mode it was read under —
 * the mode changes what the signature's `files` map even means (empty and
 * "nothing dirty" are indistinguishable from empty and "not looked", see
 * `readRepoChangeSignature`), so a mode flip has to be detected separately
 * from a real content change, not folded into the same comparison.
 */
type StoredSignature = {
	readonly signature: RepoChangeSignature;
	readonly includeUncommitted: boolean;
};

/**
 * Previous poll's signature per session, keyed by the session's public id.
 * Module-level `Map`, not `Ref`-in-context: this state belongs to exactly
 * one thing (the single background poll loop started once at boot), the
 * same shape `events.ts`'s subscriber `Set` already uses for the sidecar's
 * other piece of long-lived in-memory state. Deliberately keyed by every
 * *open* session, not just watched ones — an unwatched-but-still-open
 * session keeps its last-known signature around so `checkSessionForChanges`
 * has something to compare against the moment watching resumes (see
 * `http.ts`'s `sessions.setWatching`), rather than treating that first
 * check-after-resume as a no-comparison "first tick" that can't emit.
 */
const previousSignatures = new Map<string, StoredSignature>();

/**
 * Reads one session's cheap change signature (HEAD sha, plus — only when
 * the `includeUncommitted` setting is on — a content hash per dirty path,
 * see `readRepoChangeSignature`) and emits `session-files-changed` if it
 * moved since the last check for this session. A session's first check ever
 * (or first check since its previous signature was dropped, see below)
 * never emits — there's nothing to compare against yet.
 *
 * When the stored signature's own `includeUncommitted` mode differs from
 * this check's (the user just flipped the setting), the signature's shape
 * changed for a reason that has nothing to do with the repo — comparing
 * across modes would spuriously report "changed" any time the worktree
 * actually is dirty and the setting just turned on. That case re-baselines
 * `previousSignatures` (below) without emitting; the frontend already
 * refetches on that toggle by itself (folded into its query key), so an
 * event here would be both wrong and redundant.
 *
 * Shared by `pollOnce`'s tick and `http.ts`'s `sessions.setWatching` — the
 * latter calls this directly for the rising-edge (unwatched → watched)
 * check, so the Refresh button can appear immediately instead of waiting up
 * to `POLL_INTERVAL` for the next tick.
 *
 * A transient git failure (e.g. a rebase mid-flight) is swallowed rather
 * than failing the caller — the next tick tries again, and one session's
 * hiccup shouldn't stop every other session from being checked.
 */
export const checkSessionForChanges = (
	session: Pick<Session, "id" | "repoRoot">,
) =>
	Effect.gen(function* () {
		const settingsStore = yield* SettingsStore;
		const settings = yield* settingsStore.get();
		const includeUncommitted = settings.includeUncommitted;

		const signature = yield* readRepoChangeSignature(session.repoRoot, {
			includeUncommitted,
		});

		const previous = previousSignatures.get(session.id);
		previousSignatures.set(session.id, { signature, includeUncommitted });
		if (
			previous !== undefined &&
			previous.includeUncommitted === includeUncommitted &&
			!repoChangeSignatureEquals(previous.signature, signature)
		) {
			emit({ type: "session-files-changed", sessionId: session.id });
		}
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * One poll tick: checks every open session currently in `SessionWatch`'s
 * registry (windowFocused && Files Changed active && its tab selected — see
 * `apps/desktop/src/lib/pr-data.ts`), not every open session — an
 * unfocused/backgrounded PR isn't showing its Files Changed tab to anyone,
 * so there's no one for a poll-driven event to reach.
 */
const pollOnce = Effect.gen(function* () {
	const store = yield* Store;
	const sessionWatch = yield* SessionWatch;
	const sessions = yield* store.listSessions();
	const watchedIds = yield* sessionWatch.list();
	const watchedSessions = sessions.filter((session) =>
		watchedIds.has(session.id),
	);

	yield* Effect.forEach(watchedSessions, checkSessionForChanges, {
		concurrency: "unbounded",
	});

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
