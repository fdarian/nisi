import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import { type BlobEntry, readBlobsAtRef } from "./blob.ts";
import {
	checkLinguistGenerated,
	classifyFile,
	type FileCategory,
} from "./classify.ts";
import type { GitCommandError, GitError } from "./errors.ts";
import { git } from "./exec.ts";
import {
	createAddedBinaryFilePatch,
	createAddedFilePatch,
	patchLooksBinary,
	readPatches,
} from "./patch.ts";
import {
	type DiffTarget,
	diffTargetArgs,
	resolveHeadSha,
	resolveMergeBase,
} from "./repo.ts";

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

/** `git ls-files --others --exclude-standard -z` — untracked paths, only meaningful against `{ kind: "worktree" }`. */
const listUntrackedFiles = (repoRoot: string) =>
	git(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"]).pipe(
		Effect.map((raw) => raw.split("\0").filter((path) => path.length > 0)),
	);

/**
 * Parses `git status --porcelain=v1 -z`'s NUL-separated output down to just
 * the untracked (`"??"`) paths — the one signal `getFileContents` needs from
 * it, without a per-path `-- <path>` restriction the way `getFileContent`
 * uses it for a single file. A rename/copy entry carries an extra orig-path
 * token after it; skipped so the next token is read as a fresh status entry.
 */
const parseUntrackedPaths = (raw: string): ReadonlySet<string> => {
	const tokens = raw.split("\0").filter((token) => token.length > 0);
	const paths = new Set<string>();
	let index = 0;
	while (index < tokens.length) {
		const token = tokens[index++];
		if (token === undefined) break;
		const code = token.slice(0, 2);
		if (code === "??") paths.add(token.slice(3));
		if (code[0] === "R" || code[0] === "C") index++;
	}
	return paths;
};

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
const readContentPrefixFromWorktree = (
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

/**
 * Reads every listed path's content at `target`, capped at
 * `CONTENT_PREFIX_CAP` — the classification content-marker signal. A path
 * over the cap is simply absent from the result, not truncated. A committed
 * `target` batches through `readBlobsAtRef`; a `worktree` one has no batched
 * primitive to borrow, so each path is its own disk read.
 */
const readContentPrefixes = (
	repoRoot: string,
	target: DiffTarget,
	paths: ReadonlyArray<string>,
	fs: FileSystem,
): Effect.Effect<
	ReadonlyMap<string, string>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem
> => {
	if (target.kind === "committed") {
		return readBlobsAtRef(repoRoot, target.sha, paths, {
			maxBytes: CONTENT_PREFIX_CAP,
		}).pipe(
			Effect.map((blobs) => {
				const prefixes = new Map<string, string>();
				for (const [path, blob] of blobs) {
					if (blob.content !== null) {
						prefixes.set(path, new TextDecoder().decode(blob.content));
					}
				}
				return prefixes;
			}),
		);
	}

	return Effect.forEach(
		paths,
		(path) =>
			readContentPrefixFromWorktree(repoRoot, path, fs).pipe(
				Effect.map((prefix) => [path, prefix] as const),
			),
		{ concurrency: "unbounded" },
	).pipe(
		Effect.map((entries) => {
			const prefixes = new Map<string, string>();
			for (const [path, prefix] of entries) {
				if (prefix !== undefined) prefixes.set(path, prefix);
			}
			return prefixes;
		}),
	);
};

type GatedContent = {
	readonly content: string | undefined;
	readonly truncated: boolean;
	readonly binaryByNul: boolean;
};

const EMPTY_GATE: GatedContent = {
	content: undefined,
	truncated: false,
	binaryByNul: false,
};

/** Applies `gateBytes`' size/force tiering to a `readBlobsAtRef` lookup result — shared by `getFileContent` and `getFileContents` for a path's old-side (base) content. */
const gateFromBlob = (
	blob: BlobEntry | undefined,
	force: boolean,
): GatedContent => {
	if (blob === undefined) return EMPTY_GATE;
	if (blob.content === null) {
		return { content: undefined, truncated: true, binaryByNul: false };
	}
	return gateBytes(blob.content, blob.size, force);
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

/** Reads one path's content from disk, gated by size — the worktree-side counterpart to `gateFromBlob`. */
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
 * Every changed file's metadata for `merge-base(baseRef, headRef)..<target>`.
 * `headRef` defaults to `HEAD` — the current checkout — in which case
 * `includeUncommitted` behaves as documented below. Passing an explicit
 * `headRef` is the two-arbitrary-refs form of `nisi diff <base>..<head>`
 * (`packages/cli`): `<target>` is always that ref's own commit then,
 * `includeUncommitted` is ignored (forced off) regardless of what the caller
 * passed, and untracked files are never enumerated — nothing guarantees
 * `repoRoot`'s worktree is actually sitting on `headRef` (it commonly isn't:
 * the CLI runs from whatever the user currently has checked out, which may be
 * neither side of the diff), so overlaying it would silently show the wrong
 * branch's uncommitted edits.
 *
 * With `headRef` left at its default, `includeUncommitted: false` (the
 * common case) makes `<target>` `HEAD` — staged, unstaged, and untracked
 * changes are excluded. `includeUncommitted: true` makes `<target>` the
 * worktree itself — git's own bare commit-vs-worktree diff form — and
 * untracked files are enumerated and included too. Cheap by design: no file
 * content is fetched beyond a small classification prefix, so this stays
 * fast regardless of how many files a PR touches.
 */
export const getChangedFiles = (
	repoRoot: string,
	baseRef: string,
	options?: {
		readonly includeUncommitted?: boolean;
		readonly headRef?: string;
	},
): Effect.Effect<ReadonlyArray<FileChange>, GitError, Requirements> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const includeUncommitted =
			options?.headRef === undefined && (options?.includeUncommitted ?? false);

		const mergeBase = yield* resolveMergeBase(
			repoRoot,
			baseRef,
			options?.headRef,
		);
		const target: DiffTarget = includeUncommitted
			? { kind: "worktree" }
			: {
					kind: "committed",
					sha: yield* resolveHeadSha(repoRoot, options?.headRef),
				};

		const untrackedPathsEffect =
			target.kind === "worktree"
				? listUntrackedFiles(repoRoot)
				: Effect.succeed<ReadonlyArray<string>>([]);

		const [nameStatusRaw, numstatRaw, untrackedPaths] = yield* Effect.all(
			[
				git(repoRoot, [
					"diff",
					"--name-status",
					"-z",
					"-M",
					mergeBase,
					...diffTargetArgs(target),
				]),
				git(repoRoot, [
					"diff",
					"--numstat",
					"-z",
					"-M",
					mergeBase,
					...diffTargetArgs(target),
				]),
				untrackedPathsEffect,
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
			target,
			trackedEntries.map((entry) => ({
				path: entry.path,
				oldPath: entry.oldPath,
			})),
		);

		const linguistGenerated = yield* checkLinguistGenerated(repoRoot, [
			...trackedEntries.map((entry) => entry.path),
			...untrackedPaths,
		]);

		const prefixByPath = yield* readContentPrefixes(
			repoRoot,
			target,
			trackedEntries
				.filter((entry) => entry.status !== "deleted")
				.map((entry) => entry.path),
			fs,
		);

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

export type FileContentRequest = {
	readonly path: string;
	/**
	 * Overrides the load-on-demand size tier (up to 2MB) to actually load it —
	 * without it, that tier is reported (`truncated: true`) but never fetched.
	 * The patch-only tier above that (`LOAD_ON_DEMAND_LIMIT`) is never
	 * overridable. Per-path, since one batch commonly mixes a just-forced file
	 * with everything else.
	 */
	readonly force?: boolean;
};

/**
 * Every requested path's patch and (size-gate permitting) full before/after
 * content, at `merge-base(baseRef, HEAD)..<target>` — see `getChangedFiles`
 * for what `<target>` is and how `includeUncommitted` picks it — resolved
 * with a constant number of subprocess spawns regardless of how many paths
 * are requested — fork/exec, not git's own work, dominates the cost here, so
 * batching N requests into one call is what actually pays off, not making
 * any single call faster.
 *
 * The merge base and `name-status` are resolved once for the whole batch,
 * against `target`. Worktree `status` is resolved once too, but only when
 * `target.kind === "worktree"` — a committed target has no untracked files
 * by definition, so skipping it there isn't just an optimization, it also
 * keeps a worktree-only untracked file from leaking into a committed-mode
 * result. When it does run, `status` is deliberately unrestricted (not
 * `-- <path>` for one path) and `parseUntrackedPaths` picks the requested
 * paths back out of it, the batched equivalent of restricting a single-path
 * lookup.
 *
 * Old-side content is always at `mergeBase`, so it goes through one
 * `readBlobsAtRef` call regardless of `target`. New-side content follows
 * `target`: one more `readBlobsAtRef` call at `target.sha` when committed,
 * or one disk read per path when worktree — there's no batched primitive
 * for the worktree (see `readContentPrefixes`). Patches go through one
 * `readPatches` call, threaded with the same `target`. All three are already
 * chunked internally (`PATH_CHUNK_SIZE`) so a huge request still bounds each
 * subprocess's argument/stdin size. The one deliberate imprecision: blobs
 * are fetched under the *widest* possible tier (`LOAD_ON_DEMAND_LIMIT`)
 * regardless of each path's own `force`, since `readBlobsAtRef` takes a
 * single `maxBytes` for the whole batch — `gateFromBlob`/`gateBytes` below
 * still re-apply each path's real tier, so the only cost is occasionally
 * reading a 1-2MB blob's bytes for a path that won't end up using them.
 *
 * A requested path that isn't actually part of the diff is simply absent
 * from the result map, rather than failing the whole batch — the caller
 * decides what a missing entry means for that one path (see
 * `apps/desktop/sidecar/walkthrough/context.ts`'s `gatherGenerationContext`
 * for a caller that turns a missing entry back into a thrown
 * `FileNotChanged`, matching what a per-path fetch would have failed with).
 *
 * A rename's deletion side lives at the *old* path — restricting either the
 * `name-status` or `status` call to just the requested paths would hide it
 * from git's rename pairing, the same trap `readPatches` avoids via
 * `pathspecFor`.
 *
 * `headRef` follows `getChangedFiles`' own doc comment: left at its default
 * (`HEAD`, the current checkout), `includeUncommitted` behaves as documented
 * above; passed explicitly, `<target>` is always that ref's own commit and
 * `includeUncommitted` is ignored (forced off) — an explicit head has no
 * guaranteed relationship to what `repoRoot`'s worktree actually has checked
 * out.
 */
export const getFileContents = (
	repoRoot: string,
	baseRef: string,
	requests: ReadonlyArray<FileContentRequest>,
	options?: {
		readonly includeUncommitted?: boolean;
		readonly headRef?: string;
	},
): Effect.Effect<ReadonlyMap<string, FileContent>, GitError, Requirements> =>
	Effect.gen(function* () {
		if (requests.length === 0) return new Map();

		const fs = yield* FileSystem;
		const includeUncommitted =
			options?.headRef === undefined && (options?.includeUncommitted ?? false);

		const mergeBase = yield* resolveMergeBase(
			repoRoot,
			baseRef,
			options?.headRef,
		);
		const target: DiffTarget = includeUncommitted
			? { kind: "worktree" }
			: {
					kind: "committed",
					sha: yield* resolveHeadSha(repoRoot, options?.headRef),
				};

		const statusEffect =
			target.kind === "worktree"
				? git(repoRoot, ["status", "--porcelain=v1", "-z"])
				: Effect.succeed("");

		// Not pathspec-restricted, for the same rename-pairing reason
		// `getChangedFiles` leaves `name-status` unrestricted.
		const [nameStatusRaw, statusRaw] = yield* Effect.all(
			[
				git(repoRoot, [
					"diff",
					"--name-status",
					"-z",
					"-M",
					mergeBase,
					...diffTargetArgs(target),
				]),
				statusEffect,
			],
			{ concurrency: "unbounded" },
		);
		const nameStatusByPath = new Map(
			parseNameStatus(nameStatusRaw).map(
				(entry) => [entry.path, entry] as const,
			),
		);
		const untrackedPaths = parseUntrackedPaths(statusRaw);

		type ResolvedRequest = {
			readonly request: FileContentRequest;
			readonly entry: NameStatusEntry | undefined;
			readonly status: FileStatus;
			readonly oldBlobPath: string;
			readonly isUntracked: boolean;
		};
		const resolved: Array<ResolvedRequest> = [];
		for (const request of requests) {
			const entry = nameStatusByPath.get(request.path);
			const isUntracked =
				entry === undefined && untrackedPaths.has(request.path);
			if (entry === undefined && !isUntracked) continue;
			resolved.push({
				request,
				entry,
				status: entry?.status ?? "added",
				oldBlobPath: entry?.oldPath ?? request.path,
				isUntracked,
			});
		}

		const oldBlobPaths = resolved
			.filter((item) => item.status !== "added" && !item.isUntracked)
			.map((item) => item.oldBlobPath);
		const oldBlobs = yield* readBlobsAtRef(repoRoot, mergeBase, oldBlobPaths, {
			maxBytes: LOAD_ON_DEMAND_LIMIT,
		});

		const newBlobs: ReadonlyMap<string, BlobEntry> =
			target.kind === "committed"
				? yield* readBlobsAtRef(
						repoRoot,
						target.sha,
						resolved
							.filter((item) => item.status !== "deleted" && !item.isUntracked)
							.map((item) => item.request.path),
						{ maxBytes: LOAD_ON_DEMAND_LIMIT },
					)
				: new Map();

		const newGateEntries = yield* Effect.forEach(
			resolved,
			(item) => {
				if (item.status === "deleted") {
					return Effect.succeed([item.request.path, EMPTY_GATE] as const);
				}
				const force = item.request.force ?? false;
				return target.kind === "worktree"
					? readWorktreeGated(repoRoot, item.request.path, force, fs).pipe(
							Effect.map((gate) => [item.request.path, gate] as const),
						)
					: Effect.succeed([
							item.request.path,
							gateFromBlob(newBlobs.get(item.request.path), force),
						] as const);
			},
			{ concurrency: "unbounded" },
		);
		const newGateByPath = new Map(newGateEntries);

		const patches = yield* readPatches(
			repoRoot,
			mergeBase,
			target,
			resolved
				.filter((item) => !item.isUntracked)
				.map((item) => ({
					path: item.request.path,
					...(item.entry?.oldPath === undefined
						? {}
						: { oldPath: item.entry.oldPath }),
				})),
		);

		const result = new Map<string, FileContent>();
		for (const item of resolved) {
			const force = item.request.force ?? false;
			const oldGate: GatedContent =
				item.status === "added" || item.isUntracked
					? EMPTY_GATE
					: gateFromBlob(oldBlobs.get(item.oldBlobPath), force);
			const newGate = newGateByPath.get(item.request.path) ?? EMPTY_GATE;

			const patch = item.isUntracked
				? oldGate.binaryByNul || newGate.binaryByNul
					? createAddedBinaryFilePatch(item.request.path)
					: createAddedFilePatch(item.request.path, newGate.content ?? "")
				: (patches.get(item.request.path) ?? "");

			result.set(item.request.path, {
				patch,
				...(oldGate.content === undefined
					? {}
					: { oldContent: oldGate.content }),
				...(newGate.content === undefined
					? {}
					: { newContent: newGate.content }),
				truncated: oldGate.truncated || newGate.truncated,
			});
		}
		return result;
	});
