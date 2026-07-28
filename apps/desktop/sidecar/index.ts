import { join } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { startServer } from "./http.ts";

/** `NISI_DATA_DIR`, or `~/Library/Application Support/com.nisi.desktop` by default. */
const dataDirConfig = Config.string("NISI_DATA_DIR").pipe(
	Config.orElse(() =>
		Config.string("HOME").pipe(
			Config.map((home) =>
				join(home, "Library", "Application Support", "com.nisi.desktop"),
			),
		),
	),
);

const program = Effect.scoped(
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dataDir = yield* dataDirConfig;
		const sidecarJsonPath = join(dataDir, "sidecar.json");

		yield* fs.makeDirectory(dataDir, { recursive: true });
		// Rust's wait_for_sidecar_json accepts whatever sidecar.json it finds first,
		// with no freshness check — so a file left over from a previous boot (this
		// process's port is ephemeral, a new one every run) could otherwise be read
		// as if it were live. Clearing it before binding means there's never a
		// stale file on disk for that race to latch onto.
		yield* fs.remove(sidecarJsonPath, { force: true });

		const token = crypto.randomUUID();

		// Tied to the program's scope: interrupting the fiber (SIGINT/SIGTERM, via
		// BunRuntime.runMain below) runs this release and stops the server — the
		// sidecar's "dispose on shutdown" behavior falls out of Effect's own
		// resource safety instead of a manual process.on() handler.
		const server = yield* Effect.acquireRelease(
			Effect.sync(() => startServer(token)),
			(server) =>
				Effect.sync(() => {
					console.error("[sidecar] shutting down");
					server.stop();
				}),
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

		console.error(
			`[sidecar] running on port ${server.port}, data dir: ${dataDir}`,
		);

		yield* Effect.never;
	}),
);

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
