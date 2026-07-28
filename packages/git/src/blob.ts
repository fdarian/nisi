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

type TreeEntry = { readonly object: string; readonly type: string };

/** `git ls-tree -rz <ref>`, chunked over the path list rather than one call per path. */
const readTreeEntries = (
	repoRoot: string,
	ref: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlyMap<string, TreeEntry>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const entries = new Map<string, TreeEntry>();
		for (const pathChunk of chunk([...new Set(paths)], PATH_CHUNK_SIZE)) {
			if (pathChunk.length === 0) continue;
			const raw = yield* git(repoRoot, [
				"ls-tree",
				"-rz",
				ref,
				"--",
				...pathChunk,
			]);
			for (const record of raw.split("\0")) {
				if (record.length === 0) continue;
				const tabIndex = record.indexOf("\t");
				if (tabIndex === -1) continue;
				const [, type, object] = record.slice(0, tabIndex).split(" ");
				const path = record.slice(tabIndex + 1);
				if (type !== undefined && object !== undefined) {
					entries.set(path, { object, type });
				}
			}
		}
		return entries;
	});

type ObjectSize = { readonly size: number; readonly type: string };

/** `git cat-file --batch-check`, chunked over the object list. */
const readObjectSizes = (
	repoRoot: string,
	objects: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlyMap<string, ObjectSize>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const sizes = new Map<string, ObjectSize>();
		for (const objectChunk of chunk([...new Set(objects)], PATH_CHUNK_SIZE)) {
			if (objectChunk.length === 0) continue;
			const raw = yield* git(
				repoRoot,
				["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"],
				`${objectChunk.join("\n")}\n`,
			);
			for (const line of raw.split("\n")) {
				if (line.length === 0) continue;
				const [object, type, sizeText] = line.split(" ");
				if (
					object === undefined ||
					type === undefined ||
					sizeText === undefined
				) {
					continue;
				}
				if (type === "missing") continue;
				sizes.set(object, { size: Number(sizeText), type });
			}
		}
		return sizes;
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
 * set of paths at a ref, via batched `ls-tree` + `cat-file --batch-check` +
 * `cat-file --batch` rather than one subprocess per path. Paths missing from
 * the tree at `ref` (e.g. a file added since) are simply absent from the
 * result map.
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
		const entries = yield* readTreeEntries(repoRoot, ref, paths);
		const blobEntries = [...entries.values()].filter(
			(entry) => entry.type === "blob",
		);
		const sizes = yield* readObjectSizes(
			repoRoot,
			blobEntries.map((entry) => entry.object),
		);

		const maxBytes = options?.maxBytes;
		const readable = [...new Set(blobEntries.map((entry) => entry.object))]
			.map((object) => {
				const info = sizes.get(object);
				return info !== undefined &&
					(maxBytes === undefined || info.size <= maxBytes)
					? { object, size: info.size }
					: null;
			})
			.filter((entry) => entry !== null);

		const contents = yield* readObjectContents(repoRoot, readable);

		const result = new Map<string, BlobEntry>();
		for (const [path, entry] of entries) {
			if (entry.type !== "blob") continue;
			const info = sizes.get(entry.object);
			if (info === undefined) continue;
			result.set(path, {
				size: info.size,
				content: contents.get(entry.object) ?? null,
			});
		}
		return result;
	});
