import { BunRuntime, BunServices } from "@effect/platform-bun";
import { getDataDirConfig, SqliteDb } from "@repo/db";
import { SettingsStore } from "@repo/settings";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { attachRouter, bindHealthCheckServer } from "./http.ts";
import { startLivePolling } from "./live-poll.ts";
import { LoggingLive } from "./logging.ts";
import type { AppServices } from "./services.ts";
import { SessionWatch } from "./session-watch.ts";
import {
	acquireSidecarLock,
	publishSidecarJson,
	releaseSidecarLock,
} from "./sidecar-lock.ts";
import { Store } from "./store.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/** Same `NISI_DATA_DIR` default `@repo/db`'s `SqliteDb` resolves — shared so the handshake file and `app.db` always land in the same directory. */
const dataDirConfig = getDataDirConfig();

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* dataDirConfig;

		yield* Effect.logInfo("starting up", { dataDir });
		yield* fs.makeDirectory(dataDir, { recursive: true });

		const token = crypto.randomUUID();

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
			Effect.sync(() => bindHealthCheckServer(token)),
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

		// Atomic ownership before this process is allowed to touch
		// sidecar.json — see sidecar-lock.ts for why the old file-based
		// check-then-act (asking a pre-existing sidecar.json's own sidecar
		// whether it was alive, then unconditionally overwriting) wasn't
		// enough on its own: two sidecars booting at the same instant could
		// both find nothing live, both proceed, and both write — whichever
		// wrote last "won." The lock closes that window; its release (below)
		// runs on the same SIGINT/SIGTERM path as the server's above, and a
		// `SIGKILL`'d owner's stale lock is recovered by the liveness check
		// inside `acquireSidecarLock` itself on the next boot, not by this
		// release ever running.
		yield* Effect.acquireRelease(
			acquireSidecarLock(dataDir, { port, token }),
			() =>
				Effect.logInfo("releasing sidecar lock").pipe(
					Effect.andThen(releaseSidecarLock(dataDir)),
				),
		);

		// Safe to publish unconditionally: the lock above already proved this
		// process is the data dir's sole legitimate sidecar, so there's
		// nothing to check before overwriting whatever sidecar.json currently
		// holds. Written via temp file + rename (see publishSidecarJson) so
		// Rust's wait_for_sidecar_json and the CLI's readHandshake never
		// observe a partial file.
		yield* publishSidecarJson(dataDir, { port, token });

		// Only now — lock held, sidecar.json published — does AppServices
		// get built, which is what actually opens SqliteDb's connection and
		// runs Drizzle's migrations. Scoping MainLayer to just this
		// remaining tail of the program (rather than the whole program, the
		// way it used to be provided) is what keeps a second process from
		// ever reaching this point concurrently: it's refused, or made to
		// wait out acquireSidecarLock's dead-owner recovery, before it can.
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
// process is the data dir's confirmed sole owner.
const MainLayer = Layer.mergeAll(
	Store.layer,
	WalkthroughStore.layer,
	SettingsStore.layer,
	SessionWatch.layer,
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
