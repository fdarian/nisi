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

export function buildFileDiff(
	file: FileChange,
	content: FileContent,
): FileDiffMetadata | undefined {
	if (!content.truncated) {
		// A range claim changes the reviewed baseline without changing the file fingerprint;
		// Pierre uses these keys, not the parsed hunks, to decide whether to reuse a render.
		const contentKey = `${content.review?.baselineKind ?? "base"}:${hashItemVersion(content.patch)}`;
		return parseDiffFromFile(
			{
				name: file.oldPath ?? file.path,
				contents: content.oldContent ?? "",
				cacheKey: `${file.fingerprint}:${contentKey}:old`,
			},
			{
				name: file.path,
				contents: content.newContent ?? "",
				cacheKey: `${file.fingerprint}:${contentKey}:new`,
			},
		);
	}

	const patches = parsePatchFiles(content.patch, file.fingerprint);
	return patches[0]?.files[0];
}
