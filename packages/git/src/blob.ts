import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git, gitBytes } from "./exec.ts";

const PATH_CHUNK_SIZE = 200;
/** Caps how much blob content one `cat-file --batch` call buffers at once. */
const BATCH_BYTE_LIMIT = 32 * 1024 * 1024;

const chunk = <T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> => {
	const chunks: Array<Array<T>> = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
};

export type BlobEntry = {
	readonly size: number;
	/** `null` when the blob exists but was skipped because it exceeds `maxBytes`. */
	readonly content: Uint8Array | null;
};

/** `type` is `git`'s object type at that path (`"blob"`, or `"commit"` for a submodule); absent entirely from the map when `<ref>:<path>` doesn't resolve. */
type PathObject = {
	readonly object: string;
	readonly type: string;
	readonly size: number;
};

/**
 * Resolves every path directly to its object id, type, and size in one
 * `git cat-file --batch-check` pass, keyed by `<ref>:<path>` on stdin —
 * chunked over the path list rather than one call per path. This is what
 * lets `readBlobsAtRef` skip both the `ls-tree` path→oid lookup and a
 * second batch-check-by-oid pass for size: `--batch-check` already reports
 * all three for an arbitrary revision expression, not just a bare object id.
 * A path missing from the tree at `ref` produces a `<input> missing` line
 * (git echoes the input token verbatim), which is dropped rather than
 * mapped — batch-check preserves input order 1:1 with output lines, so a
 * chunk's paths zip directly against its output rather than needing the
 * path parsed back out of each line.
 */
const readPathObjects = (
	repoRoot: string,
	ref: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlyMap<string, PathObject>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const entries = new Map<string, PathObject>();
		for (const pathChunk of chunk([...new Set(paths)], PATH_CHUNK_SIZE)) {
			if (pathChunk.length === 0) continue;
			const raw = yield* git(
				repoRoot,
				["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
				pathChunk.map((path) => `${ref}:${path}\n`).join(""),
			);
			const lines = raw.split("\n").filter((line) => line.length > 0);
			pathChunk.forEach((path, index) => {
				const line = lines[index];
				if (line === undefined || line.endsWith(" missing")) return;
				const [object, type, sizeText] = line.split(" ");
				if (
					object === undefined ||
					type === undefined ||
					sizeText === undefined
				) {
					return;
				}
				entries.set(path, { object, type, size: Number(sizeText) });
			});
		}
		return entries;
	});

/**
 * `git cat-file --batch`, grouped so no single call buffers more than
 * `BATCH_BYTE_LIMIT` of blob content — a huge PR's blobs are read in a
 * handful of subprocess calls instead of either "one giant call" or "one
 * call per file".
 */
const readObjectContents = (
	repoRoot: string,
	objects: ReadonlyArray<{ readonly object: string; readonly size: number }>,
): Effect.Effect<
	ReadonlyMap<string, Uint8Array>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const contents = new Map<string, Uint8Array>();

		// Group objects so no single `cat-file --batch` call buffers more than
		// BATCH_BYTE_LIMIT of content, rather than batching by a fixed count.
		const batches: Array<Array<{ object: string; size: number }>> = [];
		let current: Array<{ object: string; size: number }> = [];
		let currentSize = 0;
		for (const item of objects) {
			if (currentSize > 0 && currentSize + item.size > BATCH_BYTE_LIMIT) {
				batches.push(current);
				current = [];
				currentSize = 0;
			}
			current.push(item);
			currentSize += item.size;
		}
		if (current.length > 0) batches.push(current);

		for (const batch of batches) {
			const output = yield* gitBytes(
				repoRoot,
				["cat-file", "--batch"],
				`${batch.map((item) => item.object).join("\n")}\n`,
			);
			let offset = 0;
			for (const item of batch) {
				const headerEnd = output.indexOf(10, offset);
				if (headerEnd === -1) break;
				const header = output.subarray(offset, headerEnd).toString("utf8");
				const [, type, sizeText] = header.split(" ");
				const size = Number(sizeText);
				const contentStart = headerEnd + 1;
				const contentEnd = contentStart + size;
				if (type === "blob" && Number.isFinite(size)) {
					contents.set(item.object, output.subarray(contentStart, contentEnd));
				}
				offset = contentEnd + 1;
			}
		}

		return contents;
	});

/**
 * Reads blob metadata (always) and content (when within `maxBytes`) for a
 * set of paths at a ref, via batched `cat-file --batch-check` +
 * `cat-file --batch` rather than one subprocess per path. Paths missing from
 * the tree at `ref` (e.g. a file added since), and paths that resolve to a
 * submodule rather than a blob, are simply absent from the result map.
 */
export const readBlobsAtRef = (
	repoRoot: string,
	ref: string,
	paths: ReadonlyArray<string>,
	options?: { readonly maxBytes?: number },
): Effect.Effect<
	ReadonlyMap<string, BlobEntry>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const entries = yield* readPathObjects(repoRoot, ref, paths);

		const maxBytes = options?.maxBytes;
		const blobByObject = new Map(
			[...entries.values()]
				.filter((entry) => entry.type === "blob")
				.map((entry) => [entry.object, entry] as const),
		);
		const readable = [...blobByObject.values()]
			.filter((entry) => maxBytes === undefined || entry.size <= maxBytes)
			.map((entry) => ({ object: entry.object, size: entry.size }));

		const contents = yield* readObjectContents(repoRoot, readable);

		const result = new Map<string, BlobEntry>();
		for (const [path, entry] of entries) {
			if (entry.type !== "blob") continue;
			result.set(path, {
				size: entry.size,
				content: contents.get(entry.object) ?? null,
			});
		}
		return result;
	});

/**
 * Every listed path's full content at `ref`, batched the same way as
 * `readBlobsAtRef` but without its size gate — nothing here is ever withheld
 * for being large, since this is for content-identity comparisons (hashing a
 * file to compare against a stored snapshot), not rendering. A path missing
 * from `ref`'s tree, or not a blob, is simply absent from the result map —
 * same "absent means not found" convention `readBlobsAtRef` uses.
 */
export const readFileContentsAtRef = (
	repoRoot: string,
	ref: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlyMap<string, Uint8Array>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	readBlobsAtRef(repoRoot, ref, paths).pipe(
		Effect.map((blobs) => {
			const contents = new Map<string, Uint8Array>();
			for (const [path, blob] of blobs) {
				if (blob.content !== null) contents.set(path, blob.content);
			}
			return contents;
		}),
	);
