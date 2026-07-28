import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "effect";

/** `NISI_DATA_DIR`, or `~/Library/Application Support/com.nisi.desktop` by default — the app data dir every SQLite-backed package and the sidecar's own handshake file share. */
export const getDataDirConfig = () =>
	Config.string("NISI_DATA_DIR").pipe(
		Config.withDefault(
			join(homedir(), "Library", "Application Support", "com.nisi.desktop"),
		),
	);

/**
 * The one SQLite file every domain package's tables live in. Domain packages
 * generate their own migrations against their own schema, but they're all
 * applied to this same connection at boot — see this package's AGENTS.md for
 * why there's one file instead of one per domain.
 */
export const getAppDbPath = (dataDir: string): string =>
	join(dataDir, "app.db");
