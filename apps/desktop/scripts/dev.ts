import path from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import {
	CurrentSession,
	DevSessions,
	getStickyPort,
	runManagedSubprocess,
} from "devsess";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { Command } from "effect/unstable/cli";

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
const dev = Command.make("desktop-dev", {}, () =>
	Effect.gen(function* () {
		const session = yield* CurrentSession;
		const dataDir = yield* session.path("data");

		const fs = yield* FileSystem;
		yield* fs.makeDirectory(dataDir, { recursive: true });

		// Printed as `KEY=value` so it's directly copy-pasteable in front of
		// `nisi` — a plain `nisi` targets the production data dir (the default
		// when `NISI_DATA_DIR` is unset); pointing it at this session instead is
		// `NISI_DATA_DIR=<this> nisi`. See apps/desktop/AGENTS.md.
		yield* Effect.sync(() =>
			console.log(`[dev] session: ${session.name}, NISI_DATA_DIR=${dataDir}`),
		);

		const vitePort = yield* getStickyPort(session);

		const env = {
			NISI_DATA_DIR: dataDir,
			VITE_PORT: String(vitePort),
		};

		// raceAll (not `Effect.all`): whichever subprocess exits first ends the
		// race, interrupting (and thus killing, via runManagedSubprocess's
		// acquireRelease) the other — mirrors `concurrently -k`.
		yield* Effect.raceAll([
			runManagedSubprocess("bun", ["run", "sidecar/index.ts"], { env }),
			runManagedSubprocess(
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
			),
		]);
	}).pipe(Effect.provide(CurrentSession.layer)),
);

Command.run(dev, { version: "0.1.0" }).pipe(
	Effect.provide(DevSessions.layerAt(appDir)),
	Effect.provide(BunServices.layer),
	Effect.scoped,
	BunRuntime.runMain,
);
