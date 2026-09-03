import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import { CodeIndexCacheError } from "./errors.ts";

const SCIP_EXTENSION = ".scip";

/** `repoRoot` itself isn't filesystem-safe as a directory name (slashes, arbitrary length) — same reasoning as `packages/review`'s blob store keying by content hash, here applied to the repo's own path instead of a blob's bytes. */
const hashRepoRoot = (repoRoot: string): string =>
	createHash("sha256").update(repoRoot).digest("hex");

/** `<dataDir>/code-index/<sha256(repoRoot)>/` — every `.scip` file this repo has ever had cached, one per head sha it was built against. */
const repoIndexDir = (dataDir: string, repoRoot: string): string =>
	join(dataDir, "code-index", hashRepoRoot(repoRoot));

const indexPath = (
	dataDir: string,
	repoRoot: string,
	headSha: string,
): string =>
	join(repoIndexDir(dataDir, repoRoot), `${headSha}${SCIP_EXTENSION}`);

export type CachedIndexInfo = {
	readonly headSha: string;
	readonly path: string;
	/** The file's own mtime, epoch milliseconds — there's no separate metadata store, so this *is* "when was this index generated." */
	readonly generatedAt: number;
};

const statCachedIndex = (
	fs: FileSystem,
	path: string,
	headSha: string,
): Effect.Effect<CachedIndexInfo, CodeIndexCacheError> =>
	fs.stat(path).pipe(
		Effect.map((info) => ({
			headSha,
			path,
			generatedAt: Option.getOrElse(info.mtime, () => new Date()).getTime(),
		})),
		Effect.mapError((cause) => new CodeIndexCacheError({ cause })),
	);

/** Every cached index for `repoRoot`, newest first. Empty (not an error) when the repo has never been indexed — there's simply no directory yet. */
export const listCachedIndexes = (
	dataDir: string,
	repoRoot: string,
): Effect.Effect<
	ReadonlyArray<CachedIndexInfo>,
	CodeIndexCacheError,
	FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dir = repoIndexDir(dataDir, repoRoot);
		const names = yield* fs
			.readDirectory(dir)
			.pipe(Effect.catch(() => Effect.succeed<ReadonlyArray<string>>([])));

		const entries = yield* Effect.forEach(
			names.filter((name) => name.endsWith(SCIP_EXTENSION)),
			(name) =>
				statCachedIndex(
					fs,
					join(dir, name),
					name.slice(0, -SCIP_EXTENSION.length),
				),
			{ concurrency: "unbounded" },
		);

		return [...entries].sort((a, b) => b.generatedAt - a.generatedAt);
	});

/** The cached index for `repoRoot` at exactly `headSha`, if any — what answers "is this repo's index ready for the current head." */
export const findCachedIndex = (
	dataDir: string,
	repoRoot: string,
	headSha: string,
): Effect.Effect<
	Option.Option<CachedIndexInfo>,
	CodeIndexCacheError,
	FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const path = indexPath(dataDir, repoRoot, headSha);
		const exists = yield* fs
			.exists(path)
			.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
		if (!exists) return Option.none();
		return Option.some(yield* statCachedIndex(fs, path, headSha));
	});

/** The most recently generated cached index for `repoRoot`, regardless of which head sha it was built against — what answers "is there a stale index to fall back to" when {@link findCachedIndex} misses the current head. */
export const mostRecentCachedIndex = (
	dataDir: string,
	repoRoot: string,
): Effect.Effect<
	Option.Option<CachedIndexInfo>,
	CodeIndexCacheError,
	FileSystem
> =>
	listCachedIndexes(dataDir, repoRoot).pipe(
		Effect.map((entries) => Option.fromNullishOr(entries[0])),
	);

/** How many of the most recent index files a repo's cache dir keeps — one full index can be several MB, so this bounds the data dir's growth to a small constant per reviewed repo instead of one file per commit reviewed. */
const KEEP_MOST_RECENT = 2;

/** Deletes every cached index for `repoRoot` past the {@link KEEP_MOST_RECENT} newest. Called by {@link writeIndex} after every write — never invoked on its own by a caller outside this module. */
const pruneStaleIndexes = (
	dataDir: string,
	repoRoot: string,
): Effect.Effect<void, CodeIndexCacheError, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const entries = yield* listCachedIndexes(dataDir, repoRoot);
		const stale = entries.slice(KEEP_MOST_RECENT);
		yield* Effect.forEach(
			stale,
			(entry) =>
				fs
					.remove(entry.path)
					.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause }))),
			{ concurrency: "unbounded", discard: true },
		);
	});

/** Reads a cached index's raw `.scip` bytes off disk — the caller (the sidecar's decode cache) is responsible for actually decoding them. */
export const readIndexBytes = (
	dataDir: string,
	repoRoot: string,
	headSha: string,
): Effect.Effect<Uint8Array, CodeIndexCacheError, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* fs
			.readFile(indexPath(dataDir, repoRoot, headSha))
			.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
	});

/**
 * Writes `bytes` as `repoRoot`'s cached index for `headSha`, then prunes
 * anything past the {@link KEEP_MOST_RECENT} newest — the one place a new
 * index enters the cache, so pruning happening here (rather than as a
 * separate step a caller might forget) is what keeps the invariant "at most
 * `KEEP_MOST_RECENT` files per repo" actually held.
 */
export const writeIndex = (
	dataDir: string,
	repoRoot: string,
	headSha: string,
	bytes: Uint8Array,
): Effect.Effect<void, CodeIndexCacheError, FileSystem> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		const dir = repoIndexDir(dataDir, repoRoot);
		yield* fs
			.makeDirectory(dir, { recursive: true })
			.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
		yield* fs
			.writeFile(indexPath(dataDir, repoRoot, headSha), bytes)
			.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
		yield* pruneStaleIndexes(dataDir, repoRoot);
	});
