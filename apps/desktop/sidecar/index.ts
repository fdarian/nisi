import { BunRuntime, BunServices } from "@effect/platform-bun";
import { safe } from "@orpc/client";
import { getDataDirConfig, SqliteDb } from "@repo/db";
import { SettingsStore } from "@repo/settings";
import { makeSidecarClient } from "@repo/sidecar-api";
import {
	acquireSidecar,
	releaseSidecar,
	type SidecarLivenessCheck,
} from "deskkit/sidecar";
import { Config, Effect, Layer, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ChatSessions } from "./chat/sessions.ts";
import { attachRouter, bindHealthCheckServer } from "./http.ts";
import { startLivePolling } from "./live-poll.ts";
import { LoggingLive } from "./logging.ts";
import type { AppServices } from "./services.ts";
import { SessionWatch } from "./session-watch.ts";
import { Store } from "./store.ts";
import { Updater } from "./updater/service.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/** Same `NISI_DATA_DIR` default `@repo/db`'s `SqliteDb` resolves — shared so the handshake file and `app.db` always land in the same directory. */
const dataDirConfig = getDataDirConfig();

/** How long to wait for a liveness check against a recorded owner before treating it as dead. Loopback, so both outcomes resolve fast — this only needs to outlast a live sidecar under momentary load. */
const LIVENESS_CHECK_TIMEOUT_MS = 1_000;

/**
 * True if `owner`'s sidecar answers `health.check` over the same authed oRPC
 * channel the frontend and CLI use. This — never a staleness heuristic (a
 * lock file's age, a PID that might have been reused) — is the only way to
 * tell "the process that made this handshake crashed" apart from "it's
 * genuinely still running," which is exactly what `acquireSidecar`
 * (`deskkit/sidecar`) needs this callback for.
 */
const isSidecarAlive: SidecarLivenessCheck = (owner) =>
	Effect.promise(() =>
		safe(
			makeSidecarClient(owner).health.check(undefined, {
				signal: AbortSignal.timeout(LIVENESS_CHECK_TIMEOUT_MS),
			}),
		),
	).pipe(Effect.map((result) => result.isSuccess));

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* dataDirConfig;

		yield* Effect.logInfo("starting up", { dataDir });
		yield* fs.makeDirectory(dataDir, { recursive: true });

		// `NISI_DEV_SIDECAR_PORT`/`NISI_DEV_SIDECAR_TOKEN` are only ever set by
		// `scripts/dev.ts`, which mints both once per `bun dev` run and pins them
		// for its whole lifetime — this file runs under `bun --watch` in dev, and
		// a per-boot `crypto.randomUUID()`/ephemeral `port: 0` would otherwise
		// rotate on every restart out from under a frontend that froze `{ port,
		// token }` into its own build-time env at its own boot (vite's
		// `VITE_DEV_BACKEND_*`, Rust's `get_backend` `OnceCell` cache). Unset in
		// every other boot (prod, `bun run sidecar` standalone) — falls back to
		// exactly the old per-boot-random behavior. See deskkit's sidecar README,
		// "Running the sidecar under a file watcher".
		const pinnedPort = yield* Config.number("NISI_DEV_SIDECAR_PORT").pipe(
			Config.option,
		);
		const pinnedToken = yield* Config.string("NISI_DEV_SIDECAR_TOKEN").pipe(
			Config.option,
		);
		const token = Option.getOrElse(pinnedToken, () => crypto.randomUUID());

		// Bound immediately, answering only health.check — deliberately
		// before AppServices/SqliteDb exist at all. Two concerns force this
		// order: the lock below needs a real, already-listening port to
		// record (a liveness check against a port nothing answers on yet
		// would make a concurrent sidecar wrongly think this one is dead),
		// and SqliteDb's connection must not open until this process has
		// already won that lock — otherwise two cold boots against a fresh,
		// unmigrated data dir race on Drizzle's `CREATE TABLE IF NOT EXISTS`
		// step the same way they used to race on sidecar.json. See
		// http.ts's `bindHealthCheckServer`/`attachRouter`.
		const server = yield* Effect.acquireRelease(
			Effect.sync(() =>
				bindHealthCheckServer(token, Option.getOrUndefined(pinnedPort)),
			),
			(server) =>
				Effect.logInfo("shutting down").pipe(
					Effect.andThen(Effect.sync(() => server.stop())),
				),
		);
		// Bun's type only allows `undefined` for a unix-socket server — this one
		// always binds a TCP port (`Bun.serve({ port: 0, ... })` in http.ts), so
		// an undefined port here would mean Bun itself is broken, not something
		// safe to paper over with a fallback value.
		const port = server.port;
		if (port === undefined) {
			return yield* Effect.die(
				new Error("sidecar HTTP server has no port after Bun.serve"),
			);
		}

		// Atomic ownership *and* handshake publish, in the same act — deskkit's
		// `acquireSidecar` (`deskkit/sidecar`) writes `sidecar.json` the
		// moment its `wx` (`O_EXCL`) create succeeds, so there's no separate
		// "claim now, publish later" step the way this file's own
		// `sidecar-lock.ts` used to have. Without the exclusivity half, two
		// sidecars booting at the same instant could both find nothing live,
		// both proceed, and both write — whichever wrote last "won," silently
		// splitting the app window and the CLI onto different sidecars and
		// two different SQLite writers.
		//
		// `acquireSidecar` writes directly, not via a temp file + rename, so
		// a reader can briefly observe an empty or partial `sidecar.json`
		// between the create and the write landing — Rust's
		// `wait_for_sidecar_json` (`src-tauri/src/lib.rs`) treats a read or
		// parse failure there the same as "file not there yet" and retries,
		// exactly per `deskkit/sidecar`'s README ("For non-deskkit readers of
		// `sidecar.json`"). A `SIGKILL`'d owner's stale `sidecar.json` is
		// recovered by `isSidecarAlive` inside `acquireSidecar` on the next
		// boot — or, when the recorded port is the one this process is
		// already listening on (a pinned-port dev restart under
		// `bun --watch`, or a `SIGKILL`'d sidecar whose ephemeral port got
		// reassigned), taken over without a liveness check at all; see
		// `acquireSidecar`'s own doc comment — not by this release ever
		// running.
		yield* Effect.acquireRelease(
			acquireSidecar(dataDir, { port, token }, isSidecarAlive),
			() =>
				Effect.logInfo("releasing sidecar lock").pipe(
					Effect.andThen(releaseSidecar(dataDir)),
				),
		);

		// Only now — sidecar.json claimed and published in the one act above
		// — does AppServices get built, which is what actually opens
		// SqliteDb's connection and runs Drizzle's migrations. Scoping
		// MainLayer to just this remaining tail of the program (rather than
		// the whole program, the way it used to be provided) is what keeps a
		// second process from ever reaching this point concurrently: it's
		// refused, or made to wait out `acquireSidecar`'s dead-owner
		// recovery, before it can.
		yield* Effect.provide(
			Effect.gen(function* () {
				// Captures the ambient context (every service in `AppServices`) so
				// oRPC handlers — which run as their own detached Effect per
				// request rather than as part of this program's fiber — can still
				// reach them. The walkthrough generation loop also bridges Effect
				// from its own plain `async function*` via this same captured
				// context — see `walkthrough/generate.ts`'s `runEffect`.
				const mainContext = yield* Effect.context<AppServices>();
				yield* Effect.sync(() => attachRouter(server, token, mainContext));

				yield* Effect.logInfo("ready", { port, dataDir });

				// Backgrounded, tied to this program's scope — same shutdown path
				// as the HTTP server above, just via the fiber getting
				// interrupted instead of an acquireRelease finalizer.
				yield* startLivePolling();

				// Same shape as `startLivePolling` above, for auto-update's own
				// background version check (first run ~10s out, then hourly —
				// see `updater/service.ts`).
				const updater = yield* Updater;
				yield* updater.startChecks();

				yield* Effect.never;
			}),
			MainLayer,
		);
	}),
);

// `Store.layer`, `WalkthroughStore.layer`, and `SettingsStore.layer` all need
// `SqliteDb` (the app's one shared connection — see `@repo/db`'s AGENTS.md)
// and `FileSystem`/`ChildProcessSpawner` (via `@repo/review`'s `ReviewStore`
// and, per-call, `@repo/git`'s functions). `provideMerge`, not `provide`, at
// every step — `SqliteDb`/`ReviewStore`/`BunServices` all need to stay
// available in the final context too, not just be consumed while
// constructing `Store`/`WalkthroughStore`/`SettingsStore` themselves, since
// oRPC handlers (and the walkthrough generation loop) reach some of them
// directly. Provided around only the program's tail above — deliberately
// *not* around the whole program the way `EarlyLayer` below is — so
// `SqliteDb`'s connection (and its migrations) never opens until this
// process is the data dir's confirmed sole owner. `Updater.layer` doesn't
// need `SqliteDb` at all (its state is a Ref, not a table — see its own
// doc), just `FileSystem`/`ChildProcessSpawner` from the same `BunServices`
// merge everything else here already needs.
const MainLayer = Layer.mergeAll(
	Store.layer,
	WalkthroughStore.layer,
	SettingsStore.layer,
	SessionWatch.layer,
	Updater.layer,
	ChatSessions.layer,
).pipe(
	Layer.provideMerge(SqliteDb.layer),
	Layer.provideMerge(BunServices.layer),
);

// Everything the program's prefix needs before `AppServices` exists:
// `FileSystem` (`fs.makeDirectory`, the lock, `sidecar.json`) and
// `LoggingLive` — so even the earliest "starting up" log line reaches the
// rotating file logger, not just the console, the same as before this file
// split `MainLayer` in two. Wraps the whole program, unlike `MainLayer`.
const EarlyLayer = LoggingLive.pipe(Layer.provideMerge(BunServices.layer));

BunRuntime.runMain(program.pipe(Effect.provide(EarlyLayer)));
