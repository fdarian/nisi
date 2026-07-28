import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { readBlobsAtRef } from "./blob.ts";
import {
	checkLinguistGenerated,
	classifyFile,
	type FileCategory,
} from "./classify.ts";
import { FileNotChanged, type GitError } from "./errors.ts";
import { git } from "./exec.ts";
import {
	createAddedBinaryFilePatch,
	createAddedFilePatch,
	patchLooksBinary,
	readPatches,
} from "./patch.ts";
import { resolveMergeBase } from "./repo.ts";

/** Content past this size is never read just to sniff it for classification markers. */
const CONTENT_PREFIX_CAP = 32 * 1024;
/** Below this, a file's content is always included. Matches codiff's own gate. */
const AUTO_RENDER_LIMIT = 1024 * 1024;
/** Between `AUTO_RENDER_LIMIT` and this, content is included only when `force` is set. Above it, never. */
const LOAD_ON_DEMAND_LIMIT = 2 * 1024 * 1024;

export type FileStatus = "added" | "modified" | "deleted" | "renamed";

export type FileChange = {
	readonly path: string;
	readonly oldPath?: string;
	readonly status: FileStatus;
	readonly category: FileCategory;
	readonly additions: number;
	readonly deletions: number;
	readonly fingerprint: string;
	readonly binary: boolean;
};

export type FileContent = {
	readonly patch: string;
	readonly oldContent?: string;
	readonly newContent?: string;
	readonly truncated: boolean;
};

type Requirements = ChildProcessSpawner.ChildProcessSpawner | FileSystem;

const normalizeStatus = (code: string | undefined): FileStatus =>
	code === "A" ? "added" : code === "D" ? "deleted" : "modified";

type NameStatusEntry = {
	readonly status: FileStatus;
	readonly path: string;
	readonly oldPath?: string;
};

/** Parses `git diff --name-status -z -M`'s NUL-separated output. */
const parseNameStatus = (raw: string): ReadonlyArray<NameStatusEntry> => {
	const tokens = raw.split("\0").filter((token) => token.length > 0);
	const entries: Array<NameStatusEntry> = [];
	let index = 0;
	while (index < tokens.length) {
		const code = tokens[index++];
		if (code === undefined) break;
		if (code[0] === "R" || code[0] === "C") {
			const oldPath = tokens[index++];
			const path = tokens[index++];
			if (oldPath !== undefined && path !== undefined) {
				entries.push({ status: "renamed", path, oldPath });
			}
		} else {
			const path = tokens[index++];
			if (path !== undefined) {
				entries.push({ status: normalizeStatus(code[0]), path });
			}
		}
	}
	return entries;
};

type NumstatEntry = {
	readonly path: string;
	readonly additions: number | null;
	readonly deletions: number | null;
};

/** Parses `git diff --numstat -z -M`'s NUL-separated output. `null` counts mean "binary". */
const parseNumstat = (raw: string): ReadonlyArray<NumstatEntry> => {
	const tokens = raw.split("\0").filter((token) => token.length > 0);
	const entries: Array<NumstatEntry> = [];
	let index = 0;
	while (index < tokens.length) {
		const record = tokens[index++];
		if (record === undefined) break;
		const [addedText, deletedText, inlinePath] = record.split("\t");
		const additions = addedText === "-" ? null : Number(addedText);
		const deletions = deletedText === "-" ? null : Number(deletedText);
		if (inlinePath !== undefined && inlinePath.length > 0) {
			entries.push({ path: inlinePath, additions, deletions });
		} else {
			// Rename record: the third tab-separated field is empty; the old and
			// new paths follow as their own NUL-separated tokens.
			index += 1; // skip old path — we key by new path, already have it via name-status
			const path = tokens[index++];
			if (path !== undefined) {
				entries.push({ path, additions, deletions });
			}
		}
	}
	return entries;
};

const listUntrackedFiles = (repoRoot: string) =>
	git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).pipe(
		Effect.map((raw) => raw.split("\0").filter((path) => path.length > 0)),
	);

const countLines = (content: string): number => {
	if (content.length === 0) return 0;
	const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
	return trimmed.length === 0 ? 0 : trimmed.split("\n").length;
};

const computeFingerprint = (input: {
	readonly status: string;
	readonly oldPath: string | undefined;
	readonly path: string;
	readonly patch: string;
	readonly binary: boolean;
}): string =>
	createHash("sha256")
		.update(
			`${input.status}\n${input.oldPath ?? ""}\n${input.path}\n${input.binary}\n${input.patch}`,
		)
		.digest("hex");

/** Reads a bounded content prefix from the worktree, for the classification content-marker signal. */
const readContentPrefix = (
	repoRoot: string,
	path: string,
	fs: FileSystem,
): Effect.Effect<string | undefined> =>
	fs.stat(join(repoRoot, path)).pipe(
		Effect.flatMap((stat) =>
			Number(stat.size) > CONTENT_PREFIX_CAP
				? Effect.succeed(undefined)
				: fs.readFileString(join(repoRoot, path)),
		),
		Effect.orElseSucceed(() => undefined),
	);

type GatedContent = {
	readonly content: string | undefined;
	readonly truncated: boolean;
	readonly binaryByNul: boolean;
};

const gateBytes = (
	bytes: Uint8Array,
	size: number,
	force: boolean,
): GatedContent => {
	if (size > LOAD_ON_DEMAND_LIMIT) {
		return { content: undefined, truncated: true, binaryByNul: false };
	}
	if (size > AUTO_RENDER_LIMIT && !force) {
		return { content: undefined, truncated: true, binaryByNul: false };
	}
	if (bytes.includes(0)) {
		return { content: undefined, truncated: false, binaryByNul: true };
	}
	return {
		content: new TextDecoder().decode(bytes),
		truncated: false,
		binaryByNul: false,
	};
};

const readWorktreeGated = (
	repoRoot: string,
	path: string,
	force: boolean,
	fs: FileSystem,
): Effect.Effect<GatedContent> =>
	fs.stat(join(repoRoot, path)).pipe(
		Effect.flatMap((stat) => {
			const size = Number(stat.size);
			if (size > LOAD_ON_DEMAND_LIMIT || (size > AUTO_RENDER_LIMIT && !force)) {
				return Effect.succeed<GatedContent>({
					content: undefined,
					truncated: true,
					binaryByNul: false,
				});
			}
			return fs
				.readFile(join(repoRoot, path))
				.pipe(Effect.map((bytes) => gateBytes(bytes, size, force)));
		}),
		Effect.orElseSucceed(
			(): GatedContent => ({
				content: undefined,
				truncated: false,
				binaryByNul: false,
			}),
		),
	);

/**
 * Every changed file's metadata — `merge-base(baseRef, HEAD)..worktree`,
 * including uncommitted and untracked changes. Cheap by design: no file
 * content is fetched beyond a small classification prefix, so this stays
 * fast regardless of how many files a PR touches.
 */
export const getChangedFiles = (
	repoRoot: string,
	baseRef: string,
): Effect.Effect<ReadonlyArray<FileChange>, GitError, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		const mergeBase = yield* resolveMergeBase(repoRoot, baseRef);

		const [nameStatusRaw, numstatRaw, untrackedPaths] = yield* Effect.all(
			[
				git(repoRoot, ["diff", "--name-status", "-z", "-M", mergeBase]),
				git(repoRoot, ["diff", "--numstat", "-z", "-M", mergeBase]),
				listUntrackedFiles(repoRoot),
			],
			{ concurrency: "unbounded" },
		);

		const trackedEntries = parseNameStatus(nameStatusRaw);
		const numstatByPath = new Map(
			parseNumstat(numstatRaw).map((entry) => [entry.path, entry] as const),
		);

		const trackedPatches = yield* readPatches(
			repoRoot,
			mergeBase,
			trackedEntries.map((entry) => ({
				path: entry.path,
				oldPath: entry.oldPath,
			})),
		);

		const linguistGenerated = yield* checkLinguistGenerated(repoRoot, [
			...trackedEntries.map((entry) => entry.path),
			...untrackedPaths,
		]);

		const trackedPrefixes = yield* Effect.forEach(
			trackedEntries,
			(entry) =>
				entry.status === "deleted"
					? Effect.succeed([entry.path, undefined] as const)
					: readContentPrefix(repoRoot, entry.path, fs).pipe(
							Effect.map((prefix) => [entry.path, prefix] as const),
						),
			{ concurrency: "unbounded" },
		);
		const prefixByPath = new Map(trackedPrefixes);

		const trackedChanges: Array<FileChange> = trackedEntries.map((entry) => {
			const numstat = numstatByPath.get(entry.path);
			const patch = trackedPatches.get(entry.path) ?? "";
			const binary =
				numstat !== undefined
					? numstat.additions === null
					: patchLooksBinary(patch);
			const category = classifyFile({
				path: entry.path,
				linguistGenerated: linguistGenerated.has(entry.path),
				contentPrefix: prefixByPath.get(entry.path),
			});
			return {
				path: entry.path,
				...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
				status: entry.status,
				category,
				additions: numstat?.additions ?? 0,
				deletions: numstat?.deletions ?? 0,
				binary,
				fingerprint: computeFingerprint({
					status: entry.status,
					oldPath: entry.oldPath,
					path: entry.path,
					patch,
					binary,
				}),
			};
		});

		const untrackedChanges = yield* Effect.forEach(
			untrackedPaths,
			(path) =>
				Effect.gen(function* () {
					const gated = yield* readWorktreeGated(repoRoot, path, true, fs);
					const text = gated.content ?? "";
					const binary = gated.binaryByNul;
					const patch =
						gated.truncated || binary
							? createAddedBinaryFilePatch(path)
							: createAddedFilePatch(path, text);
					const category = classifyFile({
						path,
						linguistGenerated: linguistGenerated.has(path),
						contentPrefix:
							gated.truncated || binary
								? undefined
								: text.slice(0, CONTENT_PREFIX_CAP),
					});
					const status: FileStatus = "added";
					return {
						path,
						status,
						category,
						additions: gated.truncated || binary ? 0 : countLines(text),
						deletions: 0,
						binary,
						fingerprint: computeFingerprint({
							status,
							oldPath: undefined,
							path,
							patch,
							binary,
						}),
					} satisfies FileChange;
				}),
			{ concurrency: "unbounded" },
		);

		return [...trackedChanges, ...untrackedChanges].sort((a, b) =>
			a.path.localeCompare(b.path),
		);
	});

/**
 * One file's patch and (size-gate permitting) full before/after content.
 * `force` overrides the load-on-demand tier (up to 2MB); nothing overrides
 * the patch-only tier above that.
 */
export const getFileContent = (
	repoRoot: string,
	baseRef: string,
	path: string,
	options?: { readonly force?: boolean },
): Effect.Effect<FileContent, GitError | FileNotChanged, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const force = options?.force ?? false;

		const mergeBase = yield* resolveMergeBase(repoRoot, baseRef);

		// Not pathspec-restricted: a rename's deletion side lives at the *old*
		// path, and restricting to just `path` would hide it from git's rename
		// pairing, the same trap `readPatches` avoids via `pathspecFor`.
		const [nameStatusRaw, statusRaw] = yield* Effect.all([
			git(repoRoot, ["diff", "--name-status", "-z", "-M", mergeBase]),
			git(repoRoot, ["status", "--porcelain=v1", "-z", "--", path]),
		]);
		const entry = parseNameStatus(nameStatusRaw).find(
			(candidate) => candidate.path === path,
		);
		const isUntracked = entry === undefined && statusRaw.startsWith("??");

		if (entry === undefined && !isUntracked) {
			return yield* new FileNotChanged({ path });
		}

		const status: FileStatus = entry?.status ?? "added";
		const oldPath = entry?.oldPath ?? path;

		const oldGate: GatedContent =
			status === "added" || isUntracked
				? { content: undefined, truncated: false, binaryByNul: false }
				: yield* readBlobsAtRef(repoRoot, mergeBase, [oldPath], {
						maxBytes: force ? LOAD_ON_DEMAND_LIMIT : AUTO_RENDER_LIMIT,
					}).pipe(
						Effect.map((blobs) => {
							const blob = blobs.get(oldPath);
							if (blob === undefined) {
								return {
									content: undefined,
									truncated: false,
									binaryByNul: false,
								};
							}
							if (blob.content === null) {
								return {
									content: undefined,
									truncated: true,
									binaryByNul: false,
								};
							}
							return gateBytes(blob.content, blob.size, force);
						}),
					);

		const newGate: GatedContent =
			status === "deleted"
				? { content: undefined, truncated: false, binaryByNul: false }
				: yield* readWorktreeGated(repoRoot, path, force, fs);

		const patch = isUntracked
			? oldGate.binaryByNul || newGate.binaryByNul
				? createAddedBinaryFilePatch(path)
				: createAddedFilePatch(path, newGate.content ?? "")
			: ((yield* readPatches(repoRoot, mergeBase, [
					{
						path,
						...(entry?.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
					},
				])).get(path) ?? "");

		return {
			patch,
			...(oldGate.content === undefined ? {} : { oldContent: oldGate.content }),
			...(newGate.content === undefined ? {} : { newContent: newGate.content }),
			truncated: oldGate.truncated || newGate.truncated,
		};
	});
