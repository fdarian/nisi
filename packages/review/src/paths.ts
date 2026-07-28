import { homedir } from "node:os";
import { join } from "node:path";
import { Config } from "effect";

/** `NISI_DATA_DIR`, or `~/Library/Application Support/com.nisi.desktop` by default — same default the sidecar's own handshake file uses. */
export const getDataDirConfig = () =>
	Config.string("NISI_DATA_DIR").pipe(
		Config.withDefault(
			join(homedir(), "Library", "Application Support", "com.nisi.desktop"),
		),
	);

export const getReviewDbPath = (dataDir: string): string =>
	join(dataDir, "review.db");

export const getBlobsDir = (dataDir: string): string => join(dataDir, "blobs");
