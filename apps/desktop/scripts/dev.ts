import path from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { getDataDirConfig } from "@repo/db";
import {
	CurrentSession,
	DevSessions,
	getStickyPort,
	runManagedSubprocess,
} from "devsess";
import { Config, Effect, Option, Schedule, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Command, Flag } from "effect/unstable/cli";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same shape the sidecar publishes to `sidecar.json` — see `sidecar/sidecar-lock.ts`. */
const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});

/** Fails when `sidecar.json` is missing or doesn't parse — both just mean "no handshake to read (yet)". */
const readHandshake = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const raw = yield* fs.readFileString(path.join(dataDir, "sidecar.json"));
		return yield* Effect.try(() =>
			Schema.decodeUnknownSync(SidecarHandshake)(JSON.parse(raw)),
		);
	});

/**
 * Polls `sidecar.json` until it publishes the handshake carrying `token` —
 * the exact value this run minted and handed the sidecar via
 * `NISI_DEV_SIDECAR_TOKEN` (see `env` below). Mirrors deskkit's
 * `awaitSidecarHandshake` (`deskkit/sidecar`'s README, "Running the sidecar
 * under a file watcher"): the token is pinned for the whole dev session
 * rather than freshly minted per boot, so a plain "is there a handshake at
 * all" check would false-positive on a stale one already on disk from a
 * previous run. Comparing against this exact token rules that out, and also
 * means a `--watch` restart — which republishes the same `{ port, token }` —
 * satisfies the wait again immediately instead of needing a change to detect.
 *
 * No bounded timeout, same reasoning as the old `awaitFreshHandshake` this
 * replaces: this only ever runs raced against the sidecar subprocess itself
 * (`Effect.raceAll` below), so a sidecar that dies before publishing — or
 * refuses to boot because another one holds the lock — interrupts this poll
 * along with it, rather than this function needing its own giving-up logic.
 */
const awaitHandshake = (dataDir: string, token: string) =>
	readHandshake(dataDir).pipe(
		Effect.filterOrFail(
			(handshake) => handshake.token === token,
			() => new Error("sidecar.json doesn't carry this run's token yet"),
		),
		Effect.retry(Schedule.spaced("300 millis")),
	);

/**
 * Per-devsess-session dev orchestrator. Replaces the plain two-process
 * `raceAll` this was scaffolded with — dev and prod used to share the same
 * default `NISI_DATA_DIR` (`~/Library/Application Support/com.nisi.desktop/`),
 * so a dev sidecar and the production sidecar would race to own the same
 * `sidecar.json`, and both would write the same SQLite file. Each devsess
 * session gets its own `NISI_DATA_DIR` under `.data/sessions/<slug>/data`
 * (worktrees stop clobbering each other's `sidecar.json`, and dev never
 * touches prod's) and its own sticky vite port.
 */
const dev = Command.make(
	"desktop-dev",
	{
		browser: Flag.boolean("browser").pipe(Flag.withDefault(false)),
		// Pins the vite port instead of devsess's per-session sticky one. Rarely
		// needed by hand — `.claude/launch.json` gets the same effect from
		// `autoPort`, which passes its chosen port through `PORT` (see
		// `vitePort` below).
		port: Flag.integer("port").pipe(Flag.optional),
		// Escape hatch out of devsess's per-session data dir, onto the same
		// `NISI_DATA_DIR` prod (and a plain `nisi`) resolve to — see
		// apps/desktop/AGENTS.md's "Dev/prod isolation". Safe to point at a
		// live production app: `sidecar-lock.ts`'s `acquireSidecarLock` health-
		// checks any existing owner and refuses to boot (loudly) rather than
		// splitting the data dir between two sidecars.
		prodDataDir: Flag.boolean("prod-data-dir").pipe(Flag.withDefault(false)),
		// Binds vite to `0.0.0.0` (`VITE_HOST`, read by `vite.config.ts`) instead
		// of localhost-only, so another device on the LAN can load the dev
		// server — e.g. testing `--browser` mode from a phone. Distinct from
		// `TAURI_DEV_HOST`, which points the HMR *client* at a specific address
		// for Tauri mobile dev; this only widens what the server binds to.
		host: Flag.boolean("host").pipe(Flag.withDefault(false)),
	},
	({ browser, port, prodDataDir, host }) =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const dataDir = prodDataDir
				? yield* getDataDirConfig()
				: yield* session.path("data");

			const fs = yield* FileSystem;
			yield* fs.makeDirectory(dataDir, { recursive: true });

			// Printed as `KEY=value` so it's directly copy-pasteable in front of
			// `nisi` — a plain `nisi` targets the production data dir (the default
			// when `NISI_DATA_DIR` is unset); pointing it at this session instead is
			// `NISI_DATA_DIR=<this> nisi`. See apps/desktop/AGENTS.md.
			yield* Effect.sync(() =>
				console.log(
					prodDataDir
						? `[dev] using PRODUCTION data dir, NISI_DATA_DIR=${dataDir}`
						: `[dev] session: ${session.name}, NISI_DATA_DIR=${dataDir}`,
				),
			);

			if (host) {
				yield* Effect.sync(() =>
					console.log(
						"[dev] vite bound to 0.0.0.0 — reachable from your local network",
					),
				);
			}

			// `PORT` is what `.claude/launch.json`'s `autoPort` uses to tell us
			// which port it settled on: it prefers that entry's `"port"`, falls
			// back to a free one when something already holds it (a `bun dev`
			// you started yourself), and opens its tab there — so vite has to
			// bind what it was handed, not what the session remembers.
			const envPort = yield* Config.number("PORT").pipe(Config.option);
			const pinnedPort = Option.orElse(port, () => envPort);
			const vitePort = Option.isSome(pinnedPort)
				? pinnedPort.value
				: yield* getStickyPort(session);

			// A second named sticky port, distinct from vite's above — persists
			// across separate `bun dev` runs of this session (not just restarts
			// within one), so a sidecar left behind by a killed run and this run's
			// sidecar bind the very same port even before either one has published
			// anything to `sidecar.json`. That's what lets `sidecar-lock.ts`'s
			// same-port takeover recognize a previous run's dead sidecar reliably,
			// rather than only within one run's own `bun --watch` restarts.
			//
			// The token has no sticky equivalent — it's minted fresh every run —
			// but still needs to be pinned *for* that run's whole lifetime:
			// `sidecar/index.ts` runs under `bun --watch` below, which restarts the
			// process cleanly on every save, and a per-boot `crypto.randomUUID()`
			// token would rotate under that restart out from under a frontend that
			// froze `{ port, token }` into its own env at its own boot — so every
			// request after a restart would 401 silently. See deskkit's sidecar
			// README, "Running the sidecar under a file watcher".
			const sidecarToken = crypto.randomUUID();
			const sidecarPort = yield* getStickyPort(session, { name: "sidecar" });

			const env = {
				NISI_DATA_DIR: dataDir,
				VITE_PORT: String(vitePort),
				VITE_HOST: String(host),
				NISI_DEV_SIDECAR_PORT: String(sidecarPort),
				NISI_DEV_SIDECAR_TOKEN: sidecarToken,
			};

			// `--watch`, not `--hot`: `--hot` re-runs the entry module in the same
			// process without ever unwinding the previous evaluation, so every
			// background loop (`startLivePolling`, `Updater.startChecks`) and the
			// SQLite connection from every prior boot keeps running alongside the
			// new one. `--watch` tears the process down and restarts it cleanly, so
			// exactly one instance is ever live — see deskkit's sidecar README.
			const sidecarProcess = runManagedSubprocess(
				"bun",
				["run", "--watch", "sidecar/index.ts"],
				{ env },
			);

			// `--browser`: skip the Tauri webview entirely and open a plain
			// `vite dev` tab against the sidecar instead, via the dev-only escape
			// hatch in `src/lib/backend.ts` (see apps/desktop/AGENTS.md's "Browser
			// dev harness"). Vite can't start until the sidecar has actually
			// published its handshake, so this sequences (await, then spawn vite)
			// rather than starting both at once — still raced against the sidecar
			// itself below, so a sidecar crash before publishing interrupts the
			// wait instead of hanging forever. `sidecarPort`/`sidecarToken` are
			// handed to vite directly rather than read back off the handshake —
			// this run already minted both, so re-deriving them from the file
			// `awaitHandshake` just finished polling would be a needless roundabout.
			const frontendProcess = browser
				? Effect.gen(function* () {
						yield* awaitHandshake(dataDir, sidecarToken);
						return yield* runManagedSubprocess("bun", ["run", "dev:vite"], {
							env: {
								...env,
								VITE_DEV_BACKEND_PORT: String(sidecarPort),
								VITE_DEV_BACKEND_TOKEN: sidecarToken,
							},
						});
					})
				: runManagedSubprocess(
						"bunx",
						[
							"tauri",
							"dev",
							"-c",
							JSON.stringify({
								build: { devUrl: `http://localhost:${vitePort}` },
							}),
						],
						{ env },
					);

			// raceAll (not `Effect.all`): whichever subprocess exits first ends the
			// race, interrupting (and thus killing, via runManagedSubprocess's
			// acquireRelease) the other — mirrors `concurrently -k`.
			yield* Effect.raceAll([sidecarProcess, frontendProcess]);
		}).pipe(Effect.provide(CurrentSession.layer)),
);

Command.run(dev, { version: "0.1.0" }).pipe(
	Effect.provide(DevSessions.layerAt(appDir)),
	Effect.provide(BunServices.layer),
	Effect.scoped,
	BunRuntime.runMain,
);
