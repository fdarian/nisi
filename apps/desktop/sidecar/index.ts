import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { getDataDirConfig, SqliteDb } from "@repo/db";
import { SettingsStore } from "@repo/settings";
import { Effect, Layer } from "effect";
import { FileSystem } from "effect/FileSystem";
import { startServer } from "./http.ts";
import { startLivePolling } from "./live-poll.ts";
import { LoggingLive } from "./logging.ts";
import type { AppServices } from "./services.ts";
import { Store } from "./store.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/** Same `NISI_DATA_DIR` default `@repo/db`'s `SqliteDb` resolves — shared so the handshake file and `app.db` always land in the same directory. */
const dataDirConfig = getDataDirConfig();

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* dataDirConfig;
		const sidecarJsonPath = join(dataDir, "sidecar.json");

		yield* Effect.logInfo("starting up", { dataDir });
		yield* fs.makeDirectory(dataDir, { recursive: true });

		// Rust's wait_for_sidecar_json accepts whatever sidecar.json it finds first,
		// with no freshness check — so a file left over from a previous boot (this
		// process's port is ephemeral, a new one every run) could otherwise be read
		// as if it were live. Clearing it before binding means there's never a
		// stale file on disk for that race to latch onto.
		const hadStaleFile = yield* fs.exists(sidecarJsonPath);
		yield* fs.remove(sidecarJsonPath, { force: true });
		if (hadStaleFile) {
			yield* Effect.logInfo("cleared stale sidecar.json");
		}

		const token = crypto.randomUUID();
		// Captures the ambient context (every service in `AppServices`) so oRPC
		// handlers — which run as their own detached Effect per request rather
		// than as part of this program's fiber — can still reach them. The
		// walkthrough generation loop also bridges Effect from its own plain
		// `async function*` via this same captured context — see
		// `walkthrough/generate.ts`'s `runEffect`.
		const mainContext = yield* Effect.context<AppServices>();

		// Tied to the program's scope: interrupting the fiber (SIGINT/SIGTERM, via
		// BunRuntime.runMain below) runs this release and stops the server — the
		// sidecar's "dispose on shutdown" behavior falls out of Effect's own
		// resource safety instead of a manual process.on() handler.
		const server = yield* Effect.acquireRelease(
			Effect.sync(() => startServer(token, mainContext)),
			(server) =>
				Effect.logInfo("shutting down").pipe(
					Effect.andThen(Effect.sync(() => server.stop())),
				),
		);

		yield* fs.writeFileString(
			sidecarJsonPath,
			JSON.stringify({ port: server.port, token }),
			{ mode: 0o600 },
		);
		// Belt-and-suspenders: writeFileString's `mode` only applies when the file
		// is created, so a leftover file from a previous run (different
		// permissions) wouldn't otherwise get tightened back to 0600.
		yield* fs.chmod(sidecarJsonPath, 0o600);

		yield* Effect.logInfo("ready", { port: server.port, dataDir });

		// Backgrounded, tied to this program's scope — same shutdown path as
		// the HTTP server above, just via the fiber getting interrupted instead
		// of an acquireRelease finalizer.
		yield* startLivePolling();

		yield* Effect.never;
	}),
);

// `Store.layer`, `WalkthroughStore.layer`, and `SettingsStore.layer` all need
// `SqliteDb` (the app's one shared connection — see `@repo/db`'s AGENTS.md)
// and `FileSystem`/`ChildProcessSpawner` (via `@repo/review`'s `ReviewStore`
// and, per-call, `@repo/git`'s functions). `provideMerge`, not `provide`,
// at every step — `SqliteDb`/`ReviewStore`/`BunServices` all need to stay
// available in the final context too, not just be consumed while
// constructing `Store`/`WalkthroughStore`/`SettingsStore` themselves, since
// oRPC handlers (and the walkthrough generation loop) reach some of them
// directly. `LoggingLive` joins the same merge — it also only needs
// `FileSystem` (for the rotating file logger) to construct.
const MainLayer = Layer.mergeAll(
	Store.layer,
	WalkthroughStore.layer,
	SettingsStore.layer,
	LoggingLive,
).pipe(
	Layer.provideMerge(SqliteDb.layer),
	Layer.provideMerge(BunServices.layer),
);

BunRuntime.runMain(program.pipe(Effect.provide(MainLayer)));
