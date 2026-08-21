import { BunHttpClient } from "@effect/platform-bun";
import type { UpdateState } from "@repo/sidecar-api";
import {
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Ref,
	Schedule,
} from "effect";
import { APP_BUNDLE_PATH } from "./constants.ts";
import { BREW_BIN, detectCaskInstall, fetchCaskArtifact } from "./homebrew.ts";
import { spawnRestartHelper } from "./restart-helper.ts";
import { fetchTapVersion, isNewerVersion } from "./tap-version.ts";

/** How long after boot the first version check runs — long enough that it never competes with the sidecar's own startup work for the network/subprocess slots. */
const FIRST_CHECK_DELAY = Duration.seconds(10);
/** How often the version check re-runs once it's started. */
const CHECK_INTERVAL = Duration.hours(1);

/**
 * Auto-update's whole in-memory state machine — a `Ref`-backed service
 * (service-scoped, not a module-level global, same reasoning as
 * `session-watch.ts`'s `SessionWatch`), so both the periodic background
 * check and the `update.download`/`update.restart` RPC handlers mutate the
 * same state through one owner rather than each keeping their own copy.
 * Gone on sidecar restart — nothing here is persisted, by design: a fresh
 * process re-derives `idle`/`available`/`unsupported` from a live probe
 * within the first `FIRST_CHECK_DELAY`, cheaper and less stale than
 * anything a restart could have left on disk.
 */
export class Updater extends Context.Service<Updater>()("Updater", {
	make: Effect.gen(function* () {
		const state = yield* Ref.make<UpdateState>({ type: "idle" });

		/**
		 * One version-check tick. Returns whether the caller should keep
		 * checking at all — `false` exactly once, the tick that first
		 * discovers this isn't a Homebrew cask install, since that fact can't
		 * change without a reinstall (a process restart either way).
		 *
		 * Deliberately only ever writes `unsupported`, `idle`, or `available`
		 * — `downloading`/`ready`/`failed` are owned by `download`/`restart`
		 * below, so an hourly tick can't overwrite a download in flight or an
		 * artifact already waiting for a restart out from under them.
		 */
		const checkOnce = Effect.gen(function* () {
			const probe = yield* detectCaskInstall;
			if (probe.kind === "not-installed") {
				yield* Ref.set(state, { type: "unsupported" });
				yield* Effect.logInfo(
					"nisi is not a Homebrew cask install -- auto-update checks disabled for this run",
				);
				return false;
			}
			if (probe.kind === "check-failed") {
				return true;
			}

			const current = yield* Ref.get(state);
			if (current.type !== "idle" && current.type !== "available") {
				return true;
			}

			// `BunHttpClient.layer` provided right here, not on `Updater.layer`
			// itself — `fetchTapVersion` is the only thing in this whole service
			// that ever needs `HttpClient`, and a service's returned methods
			// carry their *own* requirements independent of what `make` was
			// built with (`Layer.provide` on the layer only satisfies `make`'s
			// own construction, which never touches `HttpClient` at all). Doing
			// it here keeps `HttpClient` out of `AppServices` entirely, rather
			// than exposing every RPC handler and the walkthrough loop to a
			// dependency only this one check ever needed.
			const tapVersion = yield* fetchTapVersion.pipe(
				Effect.tapError((cause) =>
					Effect.logWarning(
						"could not check the tap for a newer nisi version -- will retry on the next check",
						{ reason: cause.reason },
					),
				),
				Effect.option,
				Effect.provide(BunHttpClient.layer),
			);
			if (Option.isNone(tapVersion)) return true;

			yield* Ref.set(
				state,
				isNewerVersion(tapVersion.value, probe.version)
					? { type: "available", version: tapVersion.value }
					: { type: "idle" },
			);
			return true;
		});

		/**
		 * Forks the periodic check into the caller's scope — same shape as
		 * `live-poll.ts`'s `startLivePolling`. `Effect.repeat`'s `while`
		 * predicate reads `checkOnce`'s own return value, so the schedule
		 * stops itself the tick `unsupported` is first discovered rather than
		 * running forever against an install that will never become one.
		 */
		const startChecks = () =>
			Effect.sleep(FIRST_CHECK_DELAY).pipe(
				Effect.andThen(
					checkOnce.pipe(
						Effect.repeat({
							schedule: Schedule.spaced(CHECK_INTERVAL),
							while: (shouldContinue) => shouldContinue,
						}),
					),
				),
				Effect.asVoid,
				Effect.forkScoped,
			);

		const status = Ref.get(state);

		/**
		 * Runs `brew fetch --cask nisi` and lands on `ready` or `failed` —
		 * always one or the other, never a silent fall-back to `idle`: a fetch
		 * that didn't work is something the user needs to see, not something
		 * to quietly forget.
		 */
		const runFetch = (version: string) =>
			fetchCaskArtifact.pipe(
				Effect.map(
					(
						result,
					):
						| { readonly ok: true }
						| { readonly ok: false; readonly message: string } =>
						result.exitCode === 0
							? { ok: true }
							: {
									ok: false,
									message:
										result.stderr.trim() ||
										`brew fetch exited with code ${result.exitCode}`,
								},
				),
				Effect.catchTag("PlatformError", (cause) =>
					Effect.succeed({ ok: false, message: cause.message } as const),
				),
				Effect.flatMap((outcome) =>
					outcome.ok
						? Ref.set(state, { type: "ready", version }).pipe(
								Effect.tap(() =>
									Effect.logInfo("update artifact cached -- ready to restart", {
										version,
									}),
								),
							)
						: Ref.set(state, {
								type: "failed",
								version,
								message: outcome.message,
							}).pipe(
								Effect.tap(() =>
									Effect.logWarning(
										"brew fetch failed while downloading the update",
										{
											version,
											message: outcome.message,
										},
									),
								),
							),
				),
			);

		/**
		 * Fire-and-forget: transitions to `downloading` synchronously (so the
		 * very next `status` poll already reflects it), then forks the actual
		 * `brew fetch` onto the global scope (`Effect.forkDetach`) rather than
		 * waiting on it — the RPC handler in `http.ts` returns the instant
		 * this resolves, exactly per the contract's doc. Accepts `failed` as a
		 * starting state as well as `available`, since a retry after a
		 * transient failure is just another `update.download` call carrying
		 * the same target version.
		 */
		const download = Effect.gen(function* () {
			const current = yield* Ref.get(state);
			if (current.type !== "available" && current.type !== "failed") {
				yield* Effect.logDebug(
					"update.download called with nothing to download",
					{
						state: current.type,
					},
				);
				return;
			}
			const version = current.version;
			yield* Ref.set(state, { type: "downloading", version });
			yield* runFetch(version).pipe(Effect.forkDetach);
		});

		/**
		 * Only meaningful from `ready` — everywhere else there's no cached
		 * artifact to install, so this is a no-op rather than an error. A
		 * helper spawn failure (disk full, `/bin/sh` missing, ...) is rare
		 * enough that it isn't worth its own `UpdateState` shape; it's folded
		 * into `failed` the same way a download failure is, since from the
		 * user's side both mean "the update didn't happen, here's why."
		 */
		const restart = Effect.gen(function* () {
			const current = yield* Ref.get(state);
			if (current.type !== "ready") {
				yield* Effect.logDebug(
					"update.restart called with nothing ready to install",
					{
						state: current.type,
					},
				);
				return;
			}

			yield* spawnRestartHelper({
				brewPath: BREW_BIN,
				appPath: APP_BUNDLE_PATH,
				appPid: process.ppid,
			}).pipe(
				Effect.catchTag("PlatformError", (cause) =>
					Ref.set(state, {
						type: "failed",
						version: current.version,
						message: cause.message,
					}).pipe(
						Effect.tap(() =>
							Effect.logWarning("failed to spawn the restart helper", {
								version: current.version,
								message: cause.message,
							}),
						),
					),
				),
			);
		});

		return { status, download, restart, startChecks };
	}),
}) {
	static layer = Layer.effect(Updater, Updater.make);
}
