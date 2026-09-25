/**
 * Turns one file's contract data (`FileChange` metadata + `diff.fileContents`'
 * `FileContent`) into the `FileDiffMetadata` `@pierre/diffs`' `CodeView`
 * renders. Picks the parser per the size tier content was gated on (≤1MB
 * auto-render, ≤2MB load-on-demand, above that patch-only):
 *
 * - Not truncated → `parseDiffFromFile`, fed real before/after contents.
 *   This is what enables expand-unchanged context, and is also what a plain
 *   add/delete looks like (one side legitimately empty, not size-gated).
 * - Truncated → `parsePatchFiles` against the always-present unified patch
 *   text (patch generation isn't size-gated server-side, only the full file
 *   bodies are) — covers both the load-on-demand tier before its "Load full
 *   file" click and the patch-only tier that can never be loaded.
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { parseDiffFromFile, parsePatchFiles } from "@pierre/diffs";
import { hashItemVersion } from "#/features/diff/viewer/item-version";
import type {
	FileChange,
	FileContent,
} from "#/features/pull-request/data/pr-data";

type CachedContentKey = { name: string; contents: string; key: string };
type ContentKeyCache = Map<
	string,
	{ old?: CachedContentKey; new?: CachedContentKey; patch?: CachedContentKey }
>;

export function createFileDiffIdentityCache(): ContentKeyCache {
	return new Map();
}

export type FileDiffIdentity =
	| { kind: "full"; signature: string; oldKey: string; newKey: string }
	| { kind: "patch"; signature: string };

function contentKey(
	cache: ContentKeyCache,
	path: string,
	side: "old" | "new" | "patch",
	name: string,
	contents: string,
): string {
	const entry = cache.get(path);
	const previous = entry?.[side];
	if (previous?.name === name && previous.contents === contents) {
		return previous.key;
	}
	const key = JSON.stringify([
		name,
		side,
		contents.length,
		hashItemVersion(contents),
	]);
	cache.set(path, {
		...entry,
		[side]: { name, contents, key },
	});
	return key;
}

export function getFileDiffIdentity(
	file: FileChange,
	content: FileContent,
	cache: ContentKeyCache = new Map(),
): FileDiffIdentity {
	if (content.truncated) {
		return {
			kind: "patch",
			signature: contentKey(
				cache,
				file.path,
				"patch",
				file.path,
				content.patch,
			),
		};
	}
	const oldKey = contentKey(
		cache,
		file.path,
		"old",
		file.oldPath ?? file.path,
		content.oldContent ?? "",
	);
	const newKey = contentKey(
		cache,
		file.path,
		"new",
		file.path,
		content.newContent ?? "",
	);
	return {
		kind: "full",
		signature: JSON.stringify([oldKey, newKey]),
		oldKey,
		newKey,
	};
}

export function buildFileDiff(
	file: FileChange,
	content: FileContent,
	identity: FileDiffIdentity = getFileDiffIdentity(file, content),
): FileDiffMetadata | undefined {
	if (!content.truncated) {
		if (identity.kind !== "full")
			throw new Error("Expected full file identity");
		return parseDiffFromFile(
			{
				name: file.oldPath ?? file.path,
				contents: content.oldContent ?? "",
				cacheKey: identity.oldKey,
			},
			{
				name: file.path,
				contents: content.newContent ?? "",
				cacheKey: identity.newKey,
			},
		);
	}

	const patches = parsePatchFiles(content.patch, file.fingerprint);
	return patches[0]?.files[0];
}
