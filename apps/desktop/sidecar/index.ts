import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { safe } from "@orpc/client";
import { getDataDirConfig, SqliteDb } from "@repo/db";
import { SettingsStore } from "@repo/settings";
import { makeSidecarClient } from "@repo/sidecar-api";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { startServer } from "./http.ts";
import { startLivePolling } from "./live-poll.ts";
import { LoggingLive } from "./logging.ts";
import type { AppServices } from "./services.ts";
import { Store } from "./store.ts";
import { WalkthroughStore } from "./walkthrough/store.ts";

/** Same `NISI_DATA_DIR` default `@repo/db`'s `SqliteDb` resolves — shared so the handshake file and `app.db` always land in the same directory. */
const dataDirConfig = getDataDirConfig();

/** How long to wait for a live-sidecar check against a pre-existing `sidecar.json` before treating it as stale. Local loopback, so failure/success both resolve fast — this only needs to be long enough that a live sidecar under momentary load isn't misread as dead. */
const LIVENESS_CHECK_TIMEOUT_MS = 1_000;

const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});

/**
 * Refused to boot because another sidecar is already live for this data dir
 * — see `refuseIfAlreadyRunning` below.
 */
class SidecarAlreadyRunning extends Schema.TaggedErrorClass<SidecarAlreadyRunning>()(
	"SidecarAlreadyRunning",
	{ port: Schema.Number },
) {}

/**
 * Two sidecars sharing one `NISI_DATA_DIR` is a real split-brain, not a
 * theoretical one: it's exactly what let the CLI's `sessions.open` land on
 * one live sidecar while the app window the user was looking at stayed
 * bound to a *different* one, each correctly reporting its own (different)
 * session list — "Opened PR #14" in the terminal, "No open pull requests"
 * in the window. `index.ts` used to unconditionally delete whatever
 * `sidecar.json` it found before binding (comment: "a file left over from a
 * previous boot ... could otherwise be read as if it were live" — true, but
 * it never checked whether that file's sidecar was *actually* dead first).
 *
 * This asks the file's own sidecar directly, over the same authed oRPC
 * channel the frontend and CLI use, rather than guessing from the file's
 * age or the port's reachability alone — a real answer from `health.check`
 * is the only way to tell "stale leftover" apart from "another instance is
 * genuinely running right now."
 */
const refuseIfAlreadyRunning = (sidecarJsonPath: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const exists = yield* fs.exists(sidecarJsonPath);
		if (!exists) {
			yield* Effect.logDebug("no existing sidecar.json found at boot");
			return;
		}

		const raw = yield* fs.readFileString(sidecarJsonPath);
		const parsed = yield* Effect.try({
			try: () => Schema.decodeUnknownSync(SidecarHandshake)(JSON.parse(raw)),
			catch: () => undefined,
		}).pipe(Effect.orElseSucceed(() => undefined));

		if (parsed === undefined) {
			yield* Effect.logDebug(
				"existing sidecar.json didn't parse — treating it as a stale leftover",
			);
			return;
		}

		const client = makeSidecarClient(parsed);
		const result = yield* Effect.promise(() =>
			safe(
				client.health.check(undefined, {
					signal: AbortSignal.timeout(LIVENESS_CHECK_TIMEOUT_MS),
				}),
			),
		);

		if (!result.isSuccess) {
			yield* Effect.logDebug(
				`existing sidecar.json (port ${parsed.port}) didn't answer — treating it as a stale leftover`,
			);
			return;
		}

		yield* Effect.logFatal(
			`refusing to start: another sidecar is already live on port ${parsed.port} for this data dir — two sidecars sharing one NISI_DATA_DIR would race over sidecar.json and the SQLite database`,
		);
		return yield* new SidecarAlreadyRunning({ port: parsed.port });
	});

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* dataDirConfig;
		const sidecarJsonPath = join(dataDir, "sidecar.json");

		yield* Effect.logInfo("starting up", { dataDir });
		yield* fs.makeDirectory(dataDir, { recursive: true });

		yield* refuseIfAlreadyRunning(sidecarJsonPath);

		// Rust's wait_for_sidecar_json accepts whatever sidecar.json it finds first,
		// with no freshness check — so a file left over from a previous boot (this
		// process's port is ephemeral, a new one every run) could otherwise be read
		// as if it were live. Clearing it before binding means there's never a
		// stale file on disk for that race to latch onto. `refuseIfAlreadyRunning`
		// above already proved (or the file didn't exist / didn't parse) that
		// whatever's here isn't a live sidecar, so removing it is safe.
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
