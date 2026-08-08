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
type SidecarHandshake = typeof SidecarHandshake.Type;

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
 * Polls `sidecar.json` until the sidecar publishes a handshake that isn't
 * `previous` — the one already on disk before this run spawned anything.
 * Mirrors Rust's `wait_for_sidecar_json`/the CLI's `readHandshake`, but with no
 * bounded timeout, since this only ever runs raced against the sidecar
 * subprocess itself: if the sidecar dies before publishing (or refuses to boot
 * because another one holds the lock), `Effect.raceAll` interrupts this poll
 * along with it.
 *
 * The `previous` comparison is what makes this actually *wait*. A sidecar
 * removes its `sidecar.lock` on shutdown but leaves `sidecar.json` behind, so
 * the last run's `{ port, token }` is still sitting there when this one starts
 * — and that port is stale, since every boot binds a fresh ephemeral one.
 * Without the check, the very first read succeeds against the dead handshake
 * and vite gets pointed at a port nothing is listening on. Compared by `token`,
 * not `port`: it's a fresh `crypto.randomUUID()` per boot, so it can't collide
 * the way a recycled ephemeral port can.
 */
const awaitFreshHandshake = (
	dataDir: string,
	previous: SidecarHandshake | undefined,
) =>
	Effect.gen(function* () {
		const handshake = yield* readHandshake(dataDir);
		if (handshake.token === previous?.token) {
			return yield* Effect.fail(
				new Error("sidecar.json still holds the pre-boot handshake"),
			);
		}
		return handshake;
	}).pipe(Effect.retry(Schedule.spaced("300 millis")));

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
		browser: Flag.boolean("browser"),
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
		prodDataDir: Flag.boolean("prod-data-dir"),
		// Binds vite to `0.0.0.0` (`VITE_HOST`, read by `vite.config.ts`) instead
		// of localhost-only, so another device on the LAN can load the dev
		// server — e.g. testing `--browser` mode from a phone. Distinct from
		// `TAURI_DEV_HOST`, which points the HMR *client* at a specific address
		// for Tauri mobile dev; this only widens what the server binds to.
		host: Flag.boolean("host"),
	},
	({ browser, port, prodDataDir, host }) =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const dataDir = prodDataDir
				? yield* getDataDirConfig()
				: yield* session.path("data");

			const fs = yield* FileSystem;
			yield* fs.makeDirectory(dataDir, { recursive: true });

			// Snapshotted before anything is spawned: whatever's on disk now
			// belongs to a previous sidecar (or a live production one under
			// `--prod-data-dir`), and it's what `awaitFreshHandshake` measures
			// our own sidecar's handshake against. Read rather than deleted —
			// deleting would rip the handshake out from under a running
			// production app, and this run's sidecar refuses to boot against a
			// live one anyway (`sidecar-lock.ts`).
			const previousHandshake = yield* readHandshake(dataDir).pipe(
				Effect.orElseSucceed(() => undefined),
			);

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

			const env = {
				NISI_DATA_DIR: dataDir,
				VITE_PORT: String(vitePort),
				VITE_HOST: String(host),
			};

			const sidecarProcess = runManagedSubprocess(
				"bun",
				["run", "--hot", "sidecar/index.ts"],
				{ env },
			);

			// `--browser`: skip the Tauri webview entirely and open a plain
			// `vite dev` tab against the sidecar instead, via the dev-only escape
			// hatch in `src/lib/backend.ts` (see apps/desktop/AGENTS.md's "Browser
			// dev harness"). Vite can't start with those env vars until the
			// sidecar has actually published its handshake, so this sequences
			// (await, then spawn vite) rather than starting both at once — still
			// raced against the sidecar itself below, so a sidecar crash before
			// publishing interrupts the wait instead of hanging forever.
			const frontendProcess = browser
				? Effect.gen(function* () {
						const handshake = yield* awaitFreshHandshake(
							dataDir,
							previousHandshake,
						);
						return yield* runManagedSubprocess("bun", ["run", "dev:vite"], {
							env: {
								...env,
								VITE_DEV_BACKEND_PORT: String(handshake.port),
								VITE_DEV_BACKEND_TOKEN: handshake.token,
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
