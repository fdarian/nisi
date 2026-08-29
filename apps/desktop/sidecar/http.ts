import type { WithEffectContext } from "@orpc/experimental-effect";
import { implement } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import {
	CORSHandlerPlugin,
	RequestHeadersHandlerPlugin,
	type RequestHeadersHandlerPluginContext,
} from "@orpc/server/plugins";
import { refreshLoginShellPath } from "@repo/bin-resolver";
import {
	fetchPullRequestChecks,
	fetchPullRequestMergeability,
	fetchRepoMergeMethods,
	type GitCommandError,
	markPullRequestReady,
	mergePullRequest,
	resolveUnpushedCommitCount,
	searchPullRequests,
	type WorktreeReadFailed,
	type WorktreeRelocationFailed,
} from "@repo/git";
import { ReviewStore } from "@repo/review";
import { SettingsStore } from "@repo/settings";
import type {
	GenerateEvent,
	HarnessId,
	Settings as WireSettings,
} from "@repo/sidecar-api";
import { contract } from "@repo/sidecar-api";
import type { Context } from "effect";
import { Effect } from "effect";
import {
	ChatSessionNotFound,
	resolveChatPromptContext,
} from "./chat/context.ts";
import { buildChatInstructions } from "./chat/prompt.ts";
import {
	closeChatThread,
	closeChatThreadsForSession,
	getOrCreateChatSession,
} from "./chat/sessions.ts";
import { streamChatTurn } from "./chat/stream.ts";
import {
	emit,
	type SidecarEvent,
	subscribe as subscribeToSidecarEvents,
} from "./events.ts";
import { listHarnesses } from "./harness/harnesses.ts";
import { checkSessionForChanges } from "./live-poll.ts";
import type { AppServices } from "./services.ts";
import { SessionWatch } from "./session-watch.ts";
import { Store } from "./store.ts";
import { Updater } from "./updater/service.ts";
import {
	beginTrackedGeneration,
	GenerateSessionNotFound,
} from "./walkthrough/generate.ts";
import {
	abortGeneration,
	attachToGeneration,
	clearGeneration,
	getGeneration,
} from "./walkthrough/generation-log.ts";
import { stopLiveSession } from "./walkthrough/live-sessions.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/**
 * `@repo/settings`'s `Settings` keeps `enabledHarnesses` as a loose
 * `string[] | null` (it stays dependency-free from this contract) — this is
 * the one place that casts it back to `HarnessId[] | null`, same as
 * `WalkthroughStore` casts its own `harness` text column at its own wire
 * boundary.
 */
const toWireSettings = (settings: {
	readonly enabledHarnesses: ReadonlyArray<string> | null;
	readonly sidebarViewMode: WireSettings["sidebarViewMode"];
	readonly diffStyleMode: WireSettings["diffStyleMode"];
	readonly preferredEditor: WireSettings["preferredEditor"];
	readonly hideReviewed: WireSettings["hideReviewed"];
	readonly includeUncommitted: WireSettings["includeUncommitted"];
	readonly walkthroughEnabled: WireSettings["walkthroughEnabled"];
}): WireSettings => ({
	enabledHarnesses:
		settings.enabledHarnesses === null
			? null
			: (settings.enabledHarnesses as ReadonlyArray<HarnessId>),
	sidebarViewMode: settings.sidebarViewMode,
	diffStyleMode: settings.diffStyleMode,
	preferredEditor: settings.preferredEditor,
	hideReviewed: settings.hideReviewed,
	includeUncommitted: settings.includeUncommitted,
	walkthroughEnabled: settings.walkthroughEnabled,
});

/**
 * `enabledHarnesses === null` means "never configured" (see
 * `@repo/settings`'s `Settings.enabledHarnesses`) — resolved here to "every
 * harness allowed" for `listHarnesses`, rather than an empty set, since an
 * unconfigured install shouldn't look like a deliberate "disable everything."
 */
const toEnabledHarnessSet = (
	enabledHarnesses: ReadonlyArray<string> | null,
): ReadonlySet<HarnessId> | null =>
	enabledHarnesses === null
		? null
		: new Set(enabledHarnesses as ReadonlyArray<HarnessId>);

/**
 * `diff.files`/`diff.fileContents` both surface any underlying
 * `GitCommandError` (merge-base resolution, status, patch/blob reads — every
 * git invocation `getChangedFiles`/`getFileContents` makes) the same way, so
 * this is shared rather than duplicated across the two handlers. `stderr` is
 * the only part of a `GitCommandError` git actually explains itself with —
 * everything else here is just enough to reproduce the failing invocation.
 * A `null` exitCode means the process never started (missing binary,
 * permissions), not "exit code 0", so it's spelled out rather than coerced.
 */
const formatGitCommandError = (cause: GitCommandError): string => {
	const invocation = [cause.command, ...cause.args].join(" ");
	const exitDescription =
		cause.exitCode === null
			? "process never started"
			: `exit code ${cause.exitCode}`;
	return `git command failed (${exitDescription}) in ${cause.cwd}: ${invocation}\n${cause.stderr.trim()}`;
};

/**
 * `diff.files`/`diff.fileContents`/`review.setViewed`/`review.setRangeViewed`
 * all read the working tree (`@repo/git`'s `readWorktreeBlobContent`,
 * transitively via `store.ts`'s `readCurrentHashes`/`setFileViewed`/
 * `setRangeViewed`), where absence is already handled as a value — anything
 * that reaches here is a genuine failure (permissions, a directory in the
 * file's place, ...), so it's an `INTERNAL_SERVER_ERROR` the same way a
 * `GitCommandError` is, not something a caller could route around.
 */
const formatWorktreeReadFailed = (cause: WorktreeReadFailed): string =>
	`failed to read ${cause.path}: ${String(cause.cause)}`;

/**
 * `store.ts`'s `resolveLiveRepoRoot` (behind `listChangedFiles`/
 * `readFileContents`/`setFileViewed`/`setRangeViewed`) already tried the
 * self-heal path — `@repo/git`'s `revalidateWorktreePath` found nothing
 * checked out on this session's branch in its known main clone either, so
 * the worktree is genuinely gone (`git worktree remove`), not just moved.
 * Names the concrete, actionable fix: close this session and reopen the PR,
 * which re-creates the worktree fresh — the same recovery a `WorktreePathOccupied`
 * or `WorktreeBranchInUse` failure on the *open* path already asks for.
 */
const formatWorktreeRelocationFailed = (
	cause: WorktreeRelocationFailed,
): string =>
	`this session's worktree (${cause.path}) no longer exists${
		cause.sourceRepoRoot === null
			? ""
			: ` and no worktree for branch "${cause.headRef}" is registered in ${cause.sourceRepoRoot}`
	} — close this session and reopen the pull request to recreate it.`;

type ServerContext = WithEffectContext<AppServices> &
	RequestHeadersHandlerPluginContext;

/**
 * Binds the real port immediately, answering only `health.check` — hand-rolled
 * to the exact wire shape `attachRouter`'s oRPC router below produces
 * (verified against `makeSidecarClient` and Rust's `is_backend_alive`),
 * deliberately *before* `AppServices` exists at all. `index.ts` needs this
 * port already listening to record it in `sidecar-lock.ts`'s lock — a
 * liveness check against a port nothing answers on yet would make a
 * concurrent sidecar wrongly think this one is dead — and `SqliteDb`'s
 * connection must not open until this process has already won that lock,
 * otherwise two cold boots race on Drizzle's migration step the same way
 * they used to race on `sidecar.json`. `attachRouter` swaps in the full
 * router once `AppServices` is ready, on this same already-bound port.
 */
export function bindHealthCheckServer(token: string) {
	return Bun.serve({
		port: 0,
		idleTimeout: 0,
		fetch(req) {
			if (new URL(req.url).pathname !== "/api/health/check") {
				return new Response("not found", { status: 404 });
			}
			if (req.headers.get("authorization") !== `Bearer ${token}`) {
				return new Response("unauthorized", { status: 401 });
			}
			return Response.json({ json: { status: "ok" } });
		},
	});
}

/**
 * Swaps `server`'s handler for the full oRPC router via `server.reload` —
 * same port, no restart, so a concurrent liveness check never observes a gap
 * where nothing's listening. Called once `AppServices` is ready, after
 * `index.ts` has already won `sidecar-lock.ts`'s lock and published
 * `sidecar.json`.
 */
export function attachRouter(
	server: ReturnType<typeof Bun.serve>,
	token: string,
	mainContext: Context.Context<AppServices>,
) {
	// `events.subscribe`/`walkthrough.generate` are plain `.handler(async
	// function* ...)` closures (see the comment on `events` below) — they
	// never go through `.effect()`'s bridging into `mainContext`, so logging
	// from inside one needs to run its own one-off Effect against the same
	// captured context every `.effect()` handler already gets implicitly.
	const runWithMainContext = <A>(
		effect: Effect.Effect<A, never, AppServices>,
	) => Effect.runPromise(Effect.provide(effect, mainContext));

	const implementer = implement(contract).$context<ServerContext>();

	const authed = implementer.use(({ context, next, errors }) => {
		const header = context.reqHeaders?.get("authorization");
		if (header !== `Bearer ${token}`) {
			throw errors.UNAUTHORIZED({ message: "missing or invalid bearer token" });
		}
		return next();
	});

	const router = authed.router({
		health: {
			// biome-ignore lint/correctness/useYield: .effect() requires a generator function even with no Effect steps
			check: authed.health.check.effect(function* () {
				return { status: "ok" as const };
			}),
		},
		sessions: {
			open: authed.sessions.open.effect(function* ({ input, errors }) {
				const store = yield* Store;
				const session = yield* store.openSession(input.cwd, input.target).pipe(
					Effect.catchTag("InvalidCwd", (cause) =>
						Effect.fail(
							errors.BAD_REQUEST({
								message: `not a git repository: ${cause.cwd}`,
							}),
						),
					),
					// `target: { kind: "pr" }` asked for a PR that isn't there —
					// the one case that refuses to degrade to a branch diff on
					// its own (see `store.ts`'s `resolveSessionTarget`). Its own
					// `NOT_FOUND` code (not `BAD_REQUEST`) so a caller can tell
					// "no PR" apart from the request itself being malformed —
					// see the contract's doc comment (`packages/sidecar-api/src/sessions.ts`).
					Effect.catchTag("NoPullRequest", (cause) =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `no open pull request for the current branch in ${cause.repoRoot}`,
							}),
						),
					),
					// `target: { kind: "branch", baseRef }` named a ref `git` couldn't
					// resolve (typically a typo) — caught here, before the session is
					// persisted, so it fails the request instead of surfacing later as
					// an opaque error the first time Files Changed loads.
					Effect.catchTag("InvalidBaseRef", (cause) =>
						Effect.fail(
							errors.BAD_REQUEST({
								message: `unknown base ref '${cause.baseRef}' in ${cause.repoRoot}: ${cause.stderr.trim()}`,
							}),
						),
					),
					// Same as `InvalidBaseRef` above, for the range-spelling form's
					// `<head>` side (`nisi diff <base>..<head>`).
					Effect.catchTag("InvalidHeadRef", (cause) =>
						Effect.fail(
							errors.BAD_REQUEST({
								message: `unknown head ref '${cause.headRef}' in ${cause.repoRoot}: ${cause.stderr.trim()}`,
							}),
						),
					),
					// A repo GitHub doesn't know about reviews against its default
					// branch instead (see `@repo/git`'s `resolveReviewTarget`) —
					// these two are the cases where there's genuinely nothing to
					// review against, or where we couldn't find out.
					Effect.catchTag("NoDefaultBranch", (cause) =>
						Effect.fail(
							errors.BAD_REQUEST({
								message: `no branch to review against in ${cause.repoRoot} — the repository has no commits on a default branch`,
							}),
						),
					),
					Effect.catchTag("GitHubUnreachable", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `could not reach GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
				);
				emit({ type: "session-opened", session });
				yield* Effect.logInfo("session opened", {
					sessionId: session.id,
					repoRoot: session.repoRoot,
					target: session.target.kind,
				});
				return session;
			}),
			list: authed.sessions.list.effect(function* () {
				const store = yield* Store;
				return yield* store.listSessions();
			}),
			close: authed.sessions.close.effect(function* ({ input, errors }) {
				const store = yield* Store;
				const sessionWatch = yield* SessionWatch;
				yield* store.closeSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				// A closed tab's sandbox session (spawned processes, leased port)
				// has no other owner — release it here rather than leaking it for
				// the sidecar's lifetime. Its retained generation log goes with
				// it — nothing left to reattach to once the session itself is gone.
				yield* Effect.promise(() => stopLiveSession(input.sessionId));
				clearGeneration(input.sessionId);
				// Chat threads are scoped per PR tab (see `chat/sessions.ts`) — a
				// closed tab's threads have no other owner either, same reasoning
				// as `stopLiveSession` above.
				yield* Effect.promise(() =>
					closeChatThreadsForSession(input.sessionId, mainContext),
				);
				// Otherwise a closed session's id lingers in the watch registry
				// forever — nothing else ever removes it, since the frontend's own
				// unmount-time `setWatching(false)` races this close and isn't
				// guaranteed to land first (or at all, if the tab close came from
				// elsewhere — the CLI, another window).
				yield* sessionWatch.remove(input.sessionId);
				emit({ type: "session-closed", sessionId: input.sessionId });
				yield* Effect.logInfo("session closed", {
					sessionId: input.sessionId,
				});
			}),
			setWatching: authed.sessions.setWatching.effect(function* ({
				input,
				errors,
			}) {
				const sessionWatch = yield* SessionWatch;

				if (!input.watching) {
					// Idempotent, no existence check — this also covers the case
					// where the session already closed (whose handler already
					// removed it above) right before this call lands.
					yield* sessionWatch.remove(input.sessionId);
					return;
				}

				const store = yield* Store;
				const sessions = yield* store.listSessions();
				const session = sessions.find(
					(candidate) => candidate.id === input.sessionId,
				);
				if (session === undefined) {
					return yield* Effect.fail(
						errors.NOT_FOUND({
							message: `session not found: ${input.sessionId}`,
						}),
					);
				}

				yield* sessionWatch.add(input.sessionId);
				// The rising-edge check: runs once, right here, rather than
				// waiting up to POLL_INTERVAL for the next tick — this is what
				// lets the Refresh affordance appear immediately on refocus.
				// Only the signature check, never a diff invalidation — applying
				// changes stays behind the user's own Refresh click.
				yield* checkSessionForChanges(input.sessionId);
			}),
		},
		diff: {
			files: authed.diff.files.effect(function* ({ input, errors }) {
				const store = yield* Store;
				return yield* store
					.listChangedFiles(input.sessionId, input.includeUncommitted ?? false)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatGitCommandError(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeReadFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeReadFailed(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeRelocationFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeRelocationFailed(cause),
								}),
							),
						),
					);
			}),
			fileContents: authed.diff.fileContents.effect(function* ({
				input,
				errors,
			}) {
				const store = yield* Store;
				return yield* store
					.readFileContents(
						input.sessionId,
						input.paths.map((request) => ({
							path: request.path,
							...(request.oldPath === undefined
								? {}
								: { oldPath: request.oldPath }),
							force: request.force ?? false,
						})),
						input.includeUncommitted ?? false,
					)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatGitCommandError(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeReadFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeReadFailed(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeRelocationFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeRelocationFailed(cause),
								}),
							),
						),
					);
			}),
		},
		review: {
			setViewed: authed.review.setViewed.effect(function* ({ input, errors }) {
				const store = yield* Store;
				yield* store
					.setFileViewed(input.sessionId, input.path, input.viewed)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
						Effect.catchTag("WorktreeReadFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeReadFailed(cause),
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatGitCommandError(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeRelocationFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeRelocationFailed(cause),
								}),
							),
						),
					);
			}),
			setRangeViewed: authed.review.setRangeViewed.effect(function* ({
				input,
				errors,
			}) {
				const store = yield* Store;
				yield* store
					.setRangeViewed(
						input.sessionId,
						input.path,
						input.blockId,
						input.blockLabel,
						input.ranges,
						input.viewed,
					)
					.pipe(
						Effect.catchTag("SessionNotFound", () =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `session not found: ${input.sessionId}`,
								}),
							),
						),
						Effect.catchTag("WorktreeReadFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeReadFailed(cause),
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatGitCommandError(cause),
								}),
							),
						),
						Effect.catchTag("WorktreeRelocationFailed", (cause) =>
							Effect.fail(
								errors.INTERNAL_SERVER_ERROR({
									message: formatWorktreeRelocationFailed(cause),
								}),
							),
						),
					);
			}),
		},
		events: {
			// Plain async-generator handler — `.effect` resolves its generator to a
			// single value via `runPromise`, so it can't hand back a live async
			// iterator. This bridges `events.ts`'s callback `subscribe` into one,
			// unsubscribing via the handler's abort `signal` on client disconnect.
			subscribe: authed.events.subscribe.handler(async function* ({ signal }) {
				const pending: Array<SidecarEvent> = [];
				let wake: (() => void) | undefined;

				const unsubscribe = subscribeToSidecarEvents((event) => {
					pending.push(event);
					wake?.();
				});
				await runWithMainContext(Effect.logDebug("event subscriber attached"));

				const onAbort = () => wake?.();
				signal?.addEventListener("abort", onAbort);

				try {
					while (signal?.aborted !== true) {
						const event = pending.shift();
						if (event !== undefined) {
							yield event;
							continue;
						}
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				} finally {
					signal?.removeEventListener("abort", onAbort);
					unsubscribe();
					await runWithMainContext(
						Effect.logDebug("event subscriber detached"),
					);
				}
			}),
		},
		walkthrough: {
			// All four adapters, each flagged `enabled` against `SettingsStore`'s
			// `enabledHarnesses` and `available` against a live bin-resolver check
			// — never fails, see `listHarnesses`.
			harnesses: authed.walkthrough.harnesses.effect(function* () {
				const settingsStore = yield* SettingsStore;
				const settings = yield* settingsStore.get();
				return yield* listHarnesses(
					toEnabledHarnessSet(settings.enabledHarnesses),
				);
			}),
			// Same as `harnesses`, but forces a fresh model-discovery attempt for
			// every enabled+available harness rather than serving the cache — the
			// UI's manual refresh action, for when a harness was just installed
			// (or removed) while the sidecar's been running. Drops
			// `@repo/bin-resolver`'s login-shell `PATH` memo in the same breath and
			// for the same reason: a CLI — or the `node` a harness bridge runs on —
			// installed through a version manager since boot stays invisible until
			// that probe re-runs, so refreshing discovery without refreshing the
			// search path would still report the harness missing.
			refreshHarnesses: authed.walkthrough.refreshHarnesses.effect(
				function* () {
					const settingsStore = yield* SettingsStore;
					const settings = yield* settingsStore.get();
					refreshLoginShellPath();
					return yield* listHarnesses(
						toEnabledHarnessSet(settings.enabledHarnesses),
						{ force: true },
					);
				},
			),
			get: authed.walkthrough.get.effect(function* ({ input, errors }) {
				const reviewStore = yield* ReviewStore;
				yield* reviewStore.getSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				const walkthroughStore = yield* WalkthroughStore;
				const record = yield* walkthroughStore.get(input.sessionId);
				if (record === null) return null;
				return {
					sessionId: record.sessionId,
					harness: record.harness,
					model: record.model,
					walkthrough: JSON.parse(record.content),
					fingerprints: record.fingerprints,
					uncoveredFiles: record.uncoveredFiles,
					generatedAt: record.generatedAt,
				};
			}),
			// A pure read over `generation-log.ts`'s in-memory state — no Store
			// call needed beyond the same session-existence check every other
			// handler here does, so a bogus sessionId gets the same NOT_FOUND
			// instead of a misleading `null`.
			activeGeneration: authed.walkthrough.activeGeneration.effect(function* ({
				input,
				errors,
			}) {
				const reviewStore = yield* ReviewStore;
				yield* reviewStore.getSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				return getGeneration(input.sessionId) ?? null;
			}),
			// Plain async-generator handler, same reason as `events.subscribe`
			// above — the multi-turn generation loop needs to push progress
			// events live, which `.effect()`'s single-resolved-value model can't.
			// Starts a generation, or reattaches to one already retained for this
			// session — see `generation-log.ts` and `generate.ts`'s
			// `beginTrackedGeneration` for how the two cases are told apart and
			// why the generation survives this specific request disconnecting.
			generate: authed.walkthrough.generate.handler(async function* ({
				input,
				errors,
			}) {
				const pending: Array<GenerateEvent> = [];
				let wake: (() => void) | undefined;
				const onEvent = (event: GenerateEvent): void => {
					pending.push(event);
					wake?.();
				};

				let unsubscribe = attachToGeneration(input.sessionId, onEvent);
				if (unsubscribe === undefined) {
					try {
						await beginTrackedGeneration(input, mainContext);
					} catch (error) {
						if (error instanceof GenerateSessionNotFound) {
							throw errors.NOT_FOUND({ message: error.message });
						}
						throw error;
					}
					unsubscribe = attachToGeneration(input.sessionId, onEvent);
				}

				try {
					while (true) {
						const event = pending.shift();
						if (event !== undefined) {
							yield event;
							if (
								event.type === "done" ||
								event.type === "failed" ||
								event.type === "cancelled"
							) {
								return;
							}
							continue;
						}
						await new Promise<void>((resolve) => {
							wake = resolve;
						});
					}
				} finally {
					unsubscribe?.();
				}
			}),
			// A no-op, not an error, when nothing's running for this session —
			// `abortGeneration` already guards on that (see `generation-log.ts`).
			// The generation loop (`generate.ts`) is what actually tears down the
			// harness session and yields the terminal `cancelled` event; this only
			// signals it.
			stop: authed.walkthrough.stop.effect(function* ({ input, errors }) {
				const reviewStore = yield* ReviewStore;
				yield* reviewStore.getSession(input.sessionId).pipe(
					Effect.catchTag("SessionNotFound", () =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `session not found: ${input.sessionId}`,
							}),
						),
					),
				);
				abortGeneration(input.sessionId);
			}),
		},
		chat: {
			// Plain async-generator handler, same reason as `events.subscribe` and
			// `walkthrough.generate` above — one turn streams live progress,
			// including prose (`text-delta`), which `.effect()`'s
			// single-resolved-value model can't. Simpler than
			// `walkthrough.generate`: no reattach/pub-sub, since a chat turn is
			// short-lived and threads are ephemeral — the request's own `signal`
			// is what a client disconnect (e.g. the chat popup closing mid-stream)
			// aborts on, and there's no separate `stop` procedure.
			send: authed.chat.send.handler(async function* ({
				input,
				errors,
				signal,
			}) {
				const promptContext = await resolveChatPromptContext(
					input.sessionId,
					mainContext,
				).catch((error) => {
					if (error instanceof ChatSessionNotFound) {
						throw errors.NOT_FOUND({ message: error.message });
					}
					throw error;
				});

				const live = await getOrCreateChatSession(
					{
						sessionId: input.sessionId,
						threadId: input.threadId,
						harness: input.harness,
						model: input.model,
						repoRoot: promptContext.repoRoot,
						instructions: buildChatInstructions(promptContext),
					},
					mainContext,
				);

				yield* streamChatTurn({
					agent: live.agent,
					session: live.session,
					message: input.message,
					abortSignal: signal,
				});
			}),
			closeThread: authed.chat.closeThread.effect(function* ({ input }) {
				yield* Effect.promise(() =>
					closeChatThread(input.threadId, mainContext),
				);
			}),
		},
		settings: {
			get: authed.settings.get.effect(function* () {
				const store = yield* SettingsStore;
				return toWireSettings(yield* store.get());
			}),
			update: authed.settings.update.effect(function* ({ input }) {
				const store = yield* SettingsStore;
				return toWireSettings(yield* store.update(input));
			}),
		},
		update: {
			status: authed.update.status.effect(function* () {
				const updater = yield* Updater;
				return yield* updater.status;
			}),
			download: authed.update.download.effect(function* () {
				const updater = yield* Updater;
				yield* updater.download;
			}),
			restart: authed.update.restart.effect(function* () {
				const updater = yield* Updater;
				yield* updater.restart;
			}),
		},
		pullRequests: {
			// Live `gh search prs`, no local index — see `@repo/git`'s
			// `searchPullRequests` for the empty-query/typed-query/qualifier
			// branching. `process.cwd()` is fine as the invocation directory: a
			// PR search spans every repo the account can see, not one checkout,
			// and `gh search prs` doesn't care what directory it runs from
			// (verified live — same results run from this repo or from `/tmp`).
			search: authed.pullRequests.search.effect(function* ({ input, errors }) {
				return yield* searchPullRequests(process.cwd(), input.query).pipe(
					Effect.catchTag("GhNotAuthenticated", (cause) =>
						Effect.fail(
							errors.GH_NOT_AUTHENTICATED({
								message: `gh is not authenticated: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhRateLimited", (cause) =>
						Effect.fail(
							errors.TOO_MANY_REQUESTS({
								message: `GitHub's search API is rate-limited right now: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GitHubSearchUnreachable", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `could not reach GitHub: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhOutputDecodeError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `gh returned output nisi couldn't parse (${cause.command})`,
							}),
						),
					),
				);
			}),
			// Creates (or reuses) a worktree for the PR, then feeds it straight
			// into `Store.openSession` — the *same* domain logic `sessions.open`
			// itself calls, not a parallel path — so the resulting session dedups
			// and lists exactly like any other. Synchronous, like `sessions.open`
			// already is: a `gh`/`git fetch` round trip plus a worktree checkout
			// is the same duration class as `sessions.open`'s own `gh` calls, not
			// the open-ended kind `walkthrough.generate`'s streaming handler
			// exists for.
			open: authed.pullRequests.open.effect(function* ({ input, errors }) {
				const store = yield* Store;
				const outcome = yield* store
					.openPullRequestSession({
						owner: input.owner,
						repo: input.repo,
						number: input.number,
					})
					.pipe(
						// `openPullRequestWorktree`'s four tagged errors are each a
						// distinct, user-actionable situation — kept as four distinct
						// contract errors rather than collapsed into one, so the
						// palette can tell the user which thing actually went wrong.
						Effect.catchTag("NoOriginRemote", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `${cause.repoRoot} has no origin remote to fetch the pull request from`,
								}),
							),
						),
						Effect.catchTag("PullRequestRefNotFound", (cause) =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `pull request #${cause.number} not found on origin — the number may be wrong, or GitHub has garbage-collected a long-closed PR's ref`,
								}),
							),
						),
						Effect.catchTag("WorktreeBranchInUse", (cause) =>
							Effect.fail(
								errors.CONFLICT({
									message: `pull request #${cause.number} is already checked out in another worktree for ${cause.repoRoot}`,
								}),
							),
						),
						Effect.catchTag("WorktreePathOccupied", (cause) =>
							Effect.fail(
								errors.PRECONDITION_FAILED({
									message: `${cause.path} exists but isn't a registered git worktree — remove it and try again`,
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.SERVICE_UNAVAILABLE({
									message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
								}),
							),
						),
						// The PR number itself is what the user picked — `gh` failing to
						// resolve it (wrong number, closed/GC'd since, an auth hiccup) is
						// a genuine error here, unlike `sessions.open`'s branch-based
						// lookup, which degrades a missing PR to a default-branch diff
						// instead. See `resolveReviewTargetForPullRequest`.
						Effect.catchTag("PullRequestNotFound", (cause) =>
							Effect.fail(
								errors.NOT_FOUND({
									message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
								}),
							),
						),
						// Same mapping `sessions.open` itself uses — only reachable here
						// if GitHub can't be reached to resolve the worktree's review
						// target.
						Effect.catchTag("NoDefaultBranch", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `no branch to review against in ${cause.repoRoot} — the repository has no commits on a default branch`,
								}),
							),
						),
						Effect.catchTag("GitHubUnreachable", (cause) =>
							Effect.fail(
								errors.SERVICE_UNAVAILABLE({
									message: `could not reach GitHub for ${cause.repoRoot}: ${cause.reason}`,
								}),
							),
						),
					);
				if (outcome.status === "opened") {
					const session = outcome.session;
					emit({ type: "session-opened", session });
					yield* Effect.logInfo("pull request worktree opened", {
						sessionId: session.id,
						repoRoot: session.repoRoot,
						pr: session.target.kind === "pr" ? session.target.number : null,
					});
				}
				return outcome;
			}),
			// The other half of the `"needs-repo-path"` flow: persists the
			// folder the user picked in the native dialog, but only once its
			// `origin` remote is confirmed to actually resolve to `owner/repo` —
			// every way that verification can fail collapses to `BAD_REQUEST`,
			// the message naming which one. Frontend calls `open` again on
			// success; nothing here opens a session itself.
			recordRepoPath: authed.pullRequests.recordRepoPath.effect(function* ({
				input,
				errors,
			}) {
				const store = yield* Store;
				return yield* store
					.recordRepoPath(input.owner, input.repo, input.path)
					.pipe(
						Effect.catchTag("RepoPathNotFound", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `${cause.path} doesn't exist`,
								}),
							),
						),
						Effect.catchTag("RepoPathNotAGitRepo", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `${cause.path} isn't a git repository`,
								}),
							),
						),
						Effect.catchTag("RepoPathNoOriginRemote", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `${cause.path} has no origin remote to verify against`,
								}),
							),
						),
						Effect.catchTag("RepoPathOriginMismatch", (cause) =>
							Effect.fail(
								errors.BAD_REQUEST({
									message: `${cause.path}'s origin remote is ${cause.actualOwner ?? "?"}/${cause.actualRepo ?? "?"}, not ${cause.expectedOwner}/${cause.expectedRepo}`,
								}),
							),
						),
						Effect.catchTag("GitCommandError", (cause) =>
							Effect.fail(
								errors.SERVICE_UNAVAILABLE({
									message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
								}),
							),
						),
					);
			}),
			// Combines `@repo/git`'s two independent `gh` reads (PR mergeability,
			// repo merge-method settings) into one round trip — the PR header's
			// Merge button needs both to decide its label/enabled state and its
			// method picker at once.
			mergeStatus: authed.pullRequests.mergeStatus.effect(function* ({
				input,
				errors,
			}) {
				const [mergeability, allowedMethods] = yield* Effect.all(
					[
						fetchPullRequestMergeability(input.repoRoot, input.number),
						fetchRepoMergeMethods(input.repoRoot, input.owner, input.repo),
					],
					{ concurrency: "unbounded" },
				).pipe(
					Effect.catchTag("GhNotAuthenticated", (cause) =>
						Effect.fail(
							errors.GH_NOT_AUTHENTICATED({
								message: `gh is not authenticated: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhRateLimited", (cause) =>
						Effect.fail(
							errors.TOO_MANY_REQUESTS({
								message: `GitHub's API is rate-limited right now: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhOutputDecodeError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `gh returned output nisi couldn't parse (${cause.command})`,
							}),
						),
					),
					Effect.catchTag("GitHubUnreachable", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `could not reach GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
							}),
						),
					),
					Effect.catchTag("PullRequestNotFound", (cause) =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
					// `mergeStateStatus` specifically requires push access to the
					// repo — deliberately not folded into `SERVICE_UNAVAILABLE`, so
					// the button can say "merge status unavailable" rather than a
					// generic connectivity failure.
					Effect.catchTag("PullRequestMergeStatusUnavailable", (cause) =>
						Effect.fail(
							errors.MERGE_STATUS_UNAVAILABLE({
								message: `couldn't determine merge status for pull request #${cause.number} in ${cause.repoRoot} — this usually means nisi doesn't have push access to the repo: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("NoMergeMethodsEnabled", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.owner}/${cause.repo} has every merge method disabled`,
							}),
						),
					),
				);

				// `allowedMethods` is guaranteed non-empty here — `fetchRepoMergeMethods`
				// already fails `NoMergeMethodsEnabled` (mapped above) when it would
				// otherwise be empty — and is already in GitHub's own Merge → Squash →
				// Rebase ordering, so the default is simply its first entry.
				const defaultMethod = allowedMethods[0];
				if (defaultMethod === undefined) {
					return yield* Effect.die(
						new Error(
							"fetchRepoMergeMethods resolved with an empty allowedMethods array",
						),
					);
				}

				return {
					state: mergeability.state,
					mergeable: mergeability.mergeable,
					mergeStateStatus: mergeability.mergeStateStatus,
					isDraft: mergeability.isDraft,
					allowedMethods,
					defaultMethod,
				};
			}),
			merge: authed.pullRequests.merge.effect(function* ({ input, errors }) {
				yield* mergePullRequest(
					input.repoRoot,
					input.number,
					input.method,
				).pipe(
					Effect.catchTag("GhNotAuthenticated", (cause) =>
						Effect.fail(
							errors.GH_NOT_AUTHENTICATED({
								message: `gh is not authenticated: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("PullRequestNotFound", (cause) =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("PullRequestNotMergeable", (cause) =>
						Effect.fail(
							errors.CONFLICT({
								message: `pull request #${cause.number} isn't mergeable right now: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhMergeFailed", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `gh pr merge failed for pull request #${cause.number}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
							}),
						),
					),
				);

				yield* Effect.logInfo("pull request merged", {
					repoRoot: input.repoRoot,
					number: input.number,
					method: input.method,
				});
			}),
			// The PR header overflow menu's "Mark as Ready" item, shown only
			// while `mergeStatus.isDraft` is true. Error mapping
			// mirrors `merge`'s minus `CONFLICT` — readiness doesn't depend on
			// mergeability.
			markReady: authed.pullRequests.markReady.effect(function* ({
				input,
				errors,
			}) {
				yield* markPullRequestReady(input.repoRoot, input.number).pipe(
					Effect.catchTag("GhNotAuthenticated", (cause) =>
						Effect.fail(
							errors.GH_NOT_AUTHENTICATED({
								message: `gh is not authenticated: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("PullRequestNotFound", (cause) =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhPullRequestReadyFailed", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `gh pr ready failed for pull request #${cause.number}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
							}),
						),
					),
				);

				yield* Effect.logInfo("pull request marked ready for review", {
					repoRoot: input.repoRoot,
					number: input.number,
				});
			}),
			// Backs the PR header's `CiStatus` ring — `@repo/git`'s
			// `fetchPullRequestChecks` mapped straight through. Error
			// classification is the PR-scoped subset of `mergeStatus`'s (no
			// `MERGE_STATUS_UNAVAILABLE` — nothing here needs push access).
			checks: authed.pullRequests.checks.effect(function* ({ input, errors }) {
				return yield* fetchPullRequestChecks(input).pipe(
					Effect.catchTag("GhNotAuthenticated", (cause) =>
						Effect.fail(
							errors.GH_NOT_AUTHENTICATED({
								message: `gh is not authenticated: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhRateLimited", (cause) =>
						Effect.fail(
							errors.TOO_MANY_REQUESTS({
								message: `GitHub's API is rate-limited right now: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GhOutputDecodeError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `gh returned output nisi couldn't parse (${cause.command})`,
							}),
						),
					),
					Effect.catchTag("PullRequestNotFound", (cause) =>
						Effect.fail(
							errors.NOT_FOUND({
								message: `pull request #${cause.number} couldn't be resolved on GitHub for ${cause.repoRoot}: ${cause.reason}`,
							}),
						),
					),
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
							}),
						),
					),
				);
			}),
			// The pre-merge "you have local unpushed commits" check — about the
			// local worktree branch, not the PR, so it only needs `repoRoot`.
			unpushedCommits: authed.pullRequests.unpushedCommits.effect(function* ({
				input,
				errors,
			}) {
				return yield* resolveUnpushedCommitCount(input.repoRoot).pipe(
					Effect.catchTag("NoRemoteRefToCompare", (cause) =>
						Effect.fail(
							errors.NO_REMOTE_REF({
								message: `${cause.branch} has no configured upstream and no matching origin/${cause.branch} in ${cause.repoRoot}`,
							}),
						),
					),
					Effect.catchTag("GitCommandError", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `${cause.command} could not be run: ${cause.stderr || String(cause.cause)}`,
							}),
						),
					),
					Effect.catchTag("UnpushedCommitCountUnparseable", (cause) =>
						Effect.fail(
							errors.SERVICE_UNAVAILABLE({
								message: `git rev-list --count against ${cause.remoteRef} in ${cause.repoRoot} returned output nisi couldn't parse: ${cause.raw}`,
							}),
						),
					),
				);
			}),
		},
	});

	const handler = new RPCHandler(router, {
		plugins: [new CORSHandlerPlugin(), new RequestHeadersHandlerPlugin()],
	});

	server.reload({
		// Disable idle timeout — matches the rest of the sidecar's HTTP posture
		// (long-lived connections, e.g. the event stream, shouldn't be cut by
		// Bun's default 10s timeout).
		idleTimeout: 0,
		async fetch(req) {
			// Generic per-call timing, covering every procedure without a
			// per-handler instrumentation pass — `path` doubles as "which
			// procedure" since RPCHandler routes `sessions.open` etc. to
			// `/api/sessions/open`. For `events.subscribe`/`walkthrough.generate`
			// (long-lived streams) `durationMs` reports the subscriber's whole
			// connected lifetime, not a request/response round trip — that's the
			// useful number for a stream, not a bug.
			const startedAt = Date.now();
			const path = new URL(req.url).pathname;
			await runWithMainContext(Effect.logDebug("rpc call started", { path }));

			const { matched, response } = await handler.handle(req, {
				prefix: "/api",
				context: { "effect/context": mainContext },
			});

			await runWithMainContext(
				Effect.logDebug("rpc call finished", {
					path,
					matched,
					status: response?.status ?? null,
					durationMs: Date.now() - startedAt,
				}),
			);

			if (matched) return response;

			return new Response("not found", { status: 404 });
		},
	});
}
