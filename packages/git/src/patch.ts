import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git } from "./exec.ts";
import { type DiffTarget, diffTargetArgs } from "./repo.ts";

const PATH_CHUNK_SIZE = 200;

const chunk = <T>(items: ReadonlyArray<T>, size: number): Array<Array<T>> => {
	const chunks: Array<Array<T>> = [];
	for (let index = 0; index < items.length; index += size) {
		chunks.push(items.slice(index, index + size));
	}
	return chunks;
};

/** Anchored to line start, matching git's own binary-diff marker exactly. */
const BINARY_PATCH_PATTERN = /^Binary files .* differ$/m;

export const patchLooksBinary = (patch: string): boolean =>
	BINARY_PATCH_PATTERN.test(patch);

const DIFF_GIT_HEADER = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/m;

/** Splits a combined `git diff` patch on `^diff --git`, keyed by the new-side path. */
export const splitPatch = (rawPatch: string): ReadonlyMap<string, string> => {
	const starts: Array<number> = [];
	const pattern = /^diff --git .+$/gm;
	for (const match of rawPatch.matchAll(pattern)) {
		starts.push(match.index);
	}

	const patches = new Map<string, string>();
	for (let index = 0; index < starts.length; index += 1) {
		const start = starts[index];
		if (start === undefined) continue;
		const end = starts[index + 1] ?? rawPatch.length;
		const part = rawPatch.slice(start, end);
		const headerLine = part.slice(
			0,
			part.indexOf("\n") === -1 ? part.length : part.indexOf("\n"),
		);
		const headerMatch = DIFF_GIT_HEADER.exec(headerLine);
		const path = headerMatch?.[2];
		if (path !== undefined) {
			patches.set(path, part);
		}
	}
	return patches;
};

export type PatchTarget = { readonly path: string; readonly oldPath?: string };

/** Every path a target's diff could appear under — the old path matters for renames: see below. */
const pathspecFor = (file: PatchTarget): ReadonlyArray<string> =>
	file.oldPath === undefined ? [file.path] : [file.oldPath, file.path];

/**
 * Patches for every file in one `git diff` call per chunk, split client-side
 * on `^diff --git`, instead of one subprocess per file. Falls back to
 * individual `git diff -- <path>` calls for a chunk when the split doesn't
 * yield exactly the files requested — quoting edge cases can make the header
 * parse ambiguous.
 *
 * A rename's `oldPath` must be included in the pathspec alongside `path`:
 * git's rename detection pairs a deletion with an addition by considering
 * both sides of the diff, and a pathspec that excludes the old path hides
 * that deletion from it entirely, so the file renders as a plain add instead
 * of a rename.
 */
export const readPatches = (
	repoRoot: string,
	mergeBase: string,
	target: DiffTarget,
	files: ReadonlyArray<PatchTarget>,
): Effect.Effect<
	ReadonlyMap<string, string>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const patches = new Map<string, string>();

		for (const fileChunk of chunk(files, PATH_CHUNK_SIZE)) {
			if (fileChunk.length === 0) continue;

			const pathspec = [...new Set(fileChunk.flatMap(pathspecFor))];
			const combined = yield* git(repoRoot, [
				"diff",
				"--no-ext-diff",
				"--find-renames",
				mergeBase,
				...diffTargetArgs(target),
				"--",
				...pathspec,
			]);
			const split = splitPatch(combined);
			const splitMatchesRequest =
				split.size === fileChunk.length &&
				fileChunk.every((file) => split.has(file.path));

			if (splitMatchesRequest) {
				for (const [path, patch] of split) {
					patches.set(path, patch);
				}
				continue;
			}

			// Degrade to per-file calls for this chunk — a rename or an
			// exotically-quoted path made the combined split ambiguous.
			for (const file of fileChunk) {
				const patch = yield* git(repoRoot, [
					"diff",
					"--no-ext-diff",
					"--find-renames",
					mergeBase,
					...diffTargetArgs(target),
					"--",
					...pathspecFor(file),
				]);
				patches.set(file.path, patch);
			}
		}

		return patches;
	});

/**
 * Synthesizes the unified diff for an untracked file — git won't diff it
 * against anything, so there's no `git diff` call that can produce this.
 */
export const createAddedFilePatch = (path: string, content: string): string => {
	const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
	const lines = trimmed.length > 0 ? trimmed.split("\n") : [];
	const body = lines.map((line) => `+${line}`).join("\n");
	const noNewline =
		content.endsWith("\n") || content.length === 0
			? ""
			: "\n\\ No newline at end of file";

	return [
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"index 0000000..0000000",
		"--- /dev/null",
		`+++ b/${path}`,
		`@@ -0,0 +1,${lines.length} @@`,
		body,
	]
		.filter((line) => line.length > 0)
		.join("\n")
		.concat(noNewline, "\n");
};

/** Synthesizes the patch text for an untracked binary file, matching git's own marker. */
export const createAddedBinaryFilePatch = (path: string): string =>
	[
		`diff --git a/${path} b/${path}`,
		"new file mode 100644",
		"index 0000000..0000000",
		`Binary files /dev/null and b/${path} differ`,
	]
		.join("\n")
		.concat("\n");
