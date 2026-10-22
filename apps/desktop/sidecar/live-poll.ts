import {
	type RepoChangeSignature,
	readRepoChangeSignature,
	repoChangeSignatureEquals,
} from "@repo/git";
import { SettingsStore } from "@repo/settings";
import { Duration, Effect, Fiber, Schedule, Semaphore } from "effect";
import { emit } from "./events.ts";
import { guideWatchedSessionIds } from "./guide/watch.ts";
import { AttentionState } from "./pull-request-attention.ts";
import { readRefState } from "./ref-state.ts";
import { watchRefs } from "./ref-watch.ts";
import { SessionWatch } from "./session-watch.ts";
import { Store } from "./store.ts";

/** How often a session that can't use the ref watcher is checked for changes. */
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
 * Previous check's signature per session, keyed by the session's public id.
 * Module-level `Map`, not `Ref`-in-context: this state belongs to exactly
 * one thing (the live checks started by `syncLiveChecks`), the
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
 * Sessions whose worktree couldn't be found at all on a previous check —
 * `Store.resolveSessionRepoRoot` (`@repo/git`'s `revalidateWorktreePath`
 * under it) found the persisted `repoRoot` gone *and* nothing checked out on
 * the session's branch in its known main clone either, so the worktree was
 * genuinely removed (`git worktree remove`), not just moved. That condition
 * is deterministic — nothing about the repo is going to make the same
 * lookup succeed on the next tick — so once it's seen for a session, this
 * poller stops attempting that session at all rather than retrying (and
 * re-warning) every `POLL_INTERVAL` for the rest of its life, the exact
 * flood a stale worktree used to cause (every git spawn against a dead
 * `cwd` logging its own `ENOENT` warning, forever). Pruned alongside
 * `previousSignatures` below when the session closes, so a session reopened
 * fresh under the same id gets a clean slate.
 */
const unresolvableSessions = new Set<string>();

/**
 * `readRepoChangeSignature`, except that when no worktree dirt is looked at
 * and `readRefState` can vouch for the repo layout, HEAD's movement is read as
 * a fingerprint of `.git/HEAD`, its branch ref and `packed-refs` — plain file
 * reads, no `git rev-parse` spawn every tick. The fingerprint stands in for
 * `headSha`; nothing outside the equality check reads it.
 */
const readSignature = (repoRoot: string, includeUncommitted: boolean) =>
	Effect.gen(function* () {
		if (!includeUncommitted) {
			const fingerprint = yield* readRefState(repoRoot, "HEAD").pipe(
				Effect.catchTag("WorktreeReadFailed", () => Effect.succeed(undefined)),
			);
			if (fingerprint !== undefined) {
				return {
					headSha: `refs:${fingerprint}`,
					files: new Map(),
				} satisfies RepoChangeSignature;
			}
		}
		return yield* readRepoChangeSignature(repoRoot, { includeUncommitted });
	});

/**
 * Reads one session's cheap change signature (HEAD sha, plus — only when
 * the `includeUncommitted` setting is on — a content hash per dirty path,
 * see `readRepoChangeSignature`) and emits `session-files-changed` if it
 * moved since the last check for this session. A session's first check ever
 * (or first check since its previous signature was dropped, see below)
 * never emits — there's nothing to compare against yet.
 *
 * `Store.resolveSessionRepoRoot` runs first — see `unresolvableSessions`
 * above for what happens when a session's worktree is permanently gone, and
 * `store.ts`'s own doc comment for the common case (nothing moved, one cheap
 * `stat()`) and the self-healing one (moved, silently re-resolved and
 * persisted so every other caller sees the same fix).
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
 * Shared by the live checks (`startLiveCheck`) and `http.ts`'s
 * `sessions.setWatching` — the latter calls this directly for the rising-edge
 * (unwatched → watched) check, so the Refresh button can appear immediately
 * instead of waiting for the next ref change or poll tick.
 *
 * A transient git failure (e.g. a rebase mid-flight) is swallowed rather
 * than failing the caller — the next check tries again, and one session's
 * hiccup shouldn't stop every other session from being checked.
 */
export const checkSessionForChanges = (sessionId: string) =>
	Effect.gen(function* () {
		if (unresolvableSessions.has(sessionId)) return;

		const store = yield* Store;
		const settingsStore = yield* SettingsStore;
		const settings = yield* settingsStore.get();
		const includeUncommitted = settings.includeUncommitted;

		const repoRoot = yield* store.resolveSessionRepoRoot(sessionId);
		const signature = yield* readSignature(repoRoot, includeUncommitted);

		const previous = previousSignatures.get(sessionId);
		previousSignatures.set(sessionId, { signature, includeUncommitted });
		if (
			previous !== undefined &&
			previous.includeUncommitted === includeUncommitted &&
			!repoChangeSignatureEquals(previous.signature, signature)
		) {
			emit({ type: "session-files-changed", sessionId });
			emit({ type: "guide-changed", sessionId });
			const attention = yield* AttentionState;
			yield* attention.markChanged(sessionId);
		}
	}).pipe(
		Effect.catchTag("WorktreeRelocationFailed", (cause) =>
			Effect.gen(function* () {
				unresolvableSessions.add(sessionId);
				yield* Effect.logWarning(
					"session worktree is gone — pausing live-update polling for this session",
					{
						sessionId,
						path: cause.path,
						headRef: cause.headRef,
						sourceRepoRoot: cause.sourceRepoRoot,
					},
				);
			}),
		),
		Effect.orElseSucceed(() => undefined),
	);

type LiveCheckServices = Effect.Services<
	ReturnType<typeof checkSessionForChanges>
>;

type LiveCheck = {
	readonly includeUncommitted: boolean;
	/** The root this check was started against, to notice a worktree that moved. */
	readonly repoRoot: string | undefined;
	readonly stop: Effect.Effect<void>;
};

/** One per session in `SessionWatch` or watched by the Guide tab. */
const liveChecks = new Map<string, LiveCheck>();

const reconcileLock = Semaphore.makeUnsafe(1);

const resolveRepoRoot = (sessionId: string) =>
	Effect.gen(function* () {
		const store = yield* Store;
		return yield* store.resolveSessionRepoRoot(sessionId);
	}).pipe(Effect.orElseSucceed(() => undefined));

/**
 * Runs `checkSessionForChanges` for one session until stopped: on every
 * filesystem change to the repo's HEAD refs (`ref-watch.ts`), or on a
 * `POLL_INTERVAL` timer when it can't watch. Polling covers
 * `includeUncommitted` (dirty paths have no cheap event source), a repo layout
 * `watchRefs` can't read, and a watcher that errors mid-life.
 */
const startLiveCheck = (sessionId: string, includeUncommitted: boolean) =>
	Effect.gen(function* () {
		const services = yield* Effect.context<LiveCheckServices>();
		const runFork = Effect.runForkWith(services);
		const check = checkSessionForChanges(sessionId);
		const poll = check.pipe(
			Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
			Effect.asVoid,
		);

		const live: {
			stopped: boolean;
			watcher: { readonly close: () => void } | undefined;
			poller: Fiber.Fiber<void> | undefined;
		} = { stopped: false, watcher: undefined, poller: undefined };

		const startPolling = () => {
			if (live.stopped || live.poller !== undefined) return;
			live.poller = runFork(poll);
		};
		const stop = Effect.suspend(() => {
			live.stopped = true;
			live.watcher?.close();
			return live.poller === undefined
				? Effect.void
				: Fiber.interrupt(live.poller);
		});

		if (includeUncommitted) {
			startPolling();
			return {
				includeUncommitted,
				repoRoot: undefined,
				stop,
			} satisfies LiveCheck;
		}

		const repoRoot = yield* resolveRepoRoot(sessionId);
		const watcher =
			repoRoot === undefined
				? undefined
				: yield* watchRefs(
						repoRoot,
						() => void runFork(check),
						(cause) => {
							live.watcher?.close();
							live.watcher = undefined;
							startPolling();
							void runFork(
								Effect.logWarning("ref watcher failed — polling instead", {
									sessionId,
									cause,
								}),
							);
						},
					).pipe(Effect.orElseSucceed(() => undefined));

		if (watcher === undefined) {
			startPolling();
		} else {
			live.watcher = watcher;
			// A ref may have moved between the caller's baseline and the watcher starting.
			void runFork(check);
		}
		return { includeUncommitted, repoRoot, stop } satisfies LiveCheck;
	});

/**
 * Brings the running live checks in line with the sessions that need one:
 * every open session in `SessionWatch` (windowFocused && Files Changed active
 * && its tab selected — see `apps/desktop/src/features/pull-request/data/pr-data.ts`)
 * or watched by the Guide tab. An unfocused/backgrounded PR isn't showing
 * anything a change event could reach. A check is restarted when the
 * `includeUncommitted` setting flipped or its worktree moved since it started.
 * Call it wherever one of those inputs changes.
 */
export const syncLiveChecks = () =>
	reconcileLock.withPermits(1)(
		Effect.gen(function* () {
			const store = yield* Store;
			const sessionWatch = yield* SessionWatch;
			const settings = yield* (yield* SettingsStore).get();
			const sessions = yield* store.listSessions();
			const openIds = new Set(sessions.map((session) => session.id));
			const desired = new Set(
				[...(yield* sessionWatch.list()), ...guideWatchedSessionIds()].filter(
					(id) => openIds.has(id),
				),
			);

			for (const [sessionId, check] of [...liveChecks]) {
				const stale =
					!desired.has(sessionId) ||
					check.includeUncommitted !== settings.includeUncommitted ||
					(!check.includeUncommitted &&
						check.repoRoot !== (yield* resolveRepoRoot(sessionId)));
				if (!stale) continue;
				liveChecks.delete(sessionId);
				yield* check.stop;
			}
			for (const sessionId of desired) {
				if (liveChecks.has(sessionId)) continue;
				liveChecks.set(
					sessionId,
					yield* startLiveCheck(sessionId, settings.includeUncommitted),
				);
			}

			// Drop signatures (and any remembered "unresolvable" state) for sessions
			// that closed, so neither map/set grows for the lifetime of a
			// long-running sidecar process.
			for (const id of previousSignatures.keys()) {
				if (!openIds.has(id)) previousSignatures.delete(id);
			}
			for (const id of unresolvableSessions) {
				if (!openIds.has(id)) unresolvableSessions.delete(id);
			}
		}),
	);
