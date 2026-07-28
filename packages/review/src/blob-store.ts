import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import { ReviewStoreError } from "./errors.ts";

/** sha256 hex digest — a blob's address in the content store. */
export const hashContent = (content: Uint8Array): string =>
	createHash("sha256").update(content).digest("hex");

/**
 * Writes a blob keyed by its own content hash — writing the same content
 * twice (from two different sessions, or two ticks of the same file) is a
 * no-op past the first write, so dedup falls out of the naming scheme rather
 * than needing its own bookkeeping.
 */
export const writeBlob = (
	blobsDir: string,
	content: Uint8Array,
): Effect.Effect<string, ReviewStoreError, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const hash = hashContent(content);
		const path = join(blobsDir, hash);
		const exists = yield* fs.exists(path);
		if (!exists) {
			yield* fs.writeFile(path, content);
		}
		return hash;
	}).pipe(Effect.mapError((cause) => new ReviewStoreError({ cause })));

export const readBlob = (
	blobsDir: string,
	hash: string,
): Effect.Effect<Uint8Array, ReviewStoreError, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* fs.readFile(join(blobsDir, hash));
	}).pipe(Effect.mapError((cause) => new ReviewStoreError({ cause })));
