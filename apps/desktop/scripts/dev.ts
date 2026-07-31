import path from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
	CurrentSession,
	DevSessions,
	getStickyPort,
	runManagedSubprocess,
} from "devsess";
import { Effect, Option, Schedule, Schema } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Command, Flag } from "effect/unstable/cli";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Same shape the sidecar publishes to `sidecar.json` — see `sidecar/sidecar-lock.ts`. */
const SidecarHandshake = Schema.Struct({
	port: Schema.Number,
	token: Schema.String,
});

/**
 * Polls `sidecar.json` until the sidecar has published its handshake. Mirrors Rust's
 * `wait_for_sidecar_json`/the CLI's `readHandshake`, but simpler: no bounded timeout,
 * since this only ever runs raced against the sidecar subprocess itself — if the
 * sidecar dies before publishing, `Effect.raceAll` interrupts this poll along with it.
 */
const awaitSidecarHandshake = (dataDir: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const raw = yield* fs.readFileString(path.join(dataDir, "sidecar.json"));
		return yield* Effect.try(() =>
			Schema.decodeUnknownSync(SidecarHandshake)(JSON.parse(raw)),
		);
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
		// Pins the vite port instead of devsess's per-session sticky one — for
		// `.claude/launch.json`, whose "port" field has to be a fixed number
		// known ahead of time, not something only discoverable from this
		// script's own stdout after it starts.
		port: Flag.integer("port").pipe(Flag.optional),
	},
	({ browser, port }) =>
		Effect.gen(function* () {
			const session = yield* CurrentSession;
			const dataDir = yield* session.path("data");

			const fs = yield* FileSystem;
			yield* fs.makeDirectory(dataDir, { recursive: true });

			// A sidecar removes its `sidecar.lock` on shutdown but leaves
			// `sidecar.json` behind, so the previous run's `{ port, token }` is
			// still sitting there when this one starts — and the port is stale,
			// since each boot binds a fresh ephemeral one. Clearing it first is
			// what makes `awaitSidecarHandshake` below actually wait: otherwise
			// its very first read succeeds against the dead handshake and vite
			// gets pointed at a port nothing is listening on.
			yield* fs.remove(path.join(dataDir, "sidecar.json"), { force: true });

			// Printed as `KEY=value` so it's directly copy-pasteable in front of
			// `nisi` — a plain `nisi` targets the production data dir (the default
			// when `NISI_DATA_DIR` is unset); pointing it at this session instead is
			// `NISI_DATA_DIR=<this> nisi`. See apps/desktop/AGENTS.md.
			yield* Effect.sync(() =>
				console.log(`[dev] session: ${session.name}, NISI_DATA_DIR=${dataDir}`),
			);

			const vitePort = Option.isSome(port)
				? port.value
				: yield* getStickyPort(session);

			const env = {
				NISI_DATA_DIR: dataDir,
				VITE_PORT: String(vitePort),
			};

			const sidecarProcess = runManagedSubprocess(
				"bun",
				["run", "sidecar/index.ts"],
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
						const handshake = yield* awaitSidecarHandshake(dataDir);
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
