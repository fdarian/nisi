import { join } from "node:path";
import {
	buildIndex,
	type CodeIndex,
	CodeIndexCacheError,
	decodeIndex,
	definitionsOf,
	detectTsConfigPresence,
	displayNameOf,
	documentationOf,
	findCachedIndex,
	hasDefinition,
	mostRecentCachedIndex,
	occurrencesInDocument,
	readIndexBytes,
	referenceCount,
	referencesOf,
	type ScipDecodeError,
	type ScipTypescriptIndexError,
	type ScipTypescriptInstallError,
	type SymbolKey,
	writeIndex,
} from "@repo/code-index";
import { getDataDirConfig } from "@repo/db";
import type {
	CodeIndexFileReferences,
	CodeIndexOccurrence,
	CodeIndexReferencesResult,
	CodeIndexStatus,
} from "@repo/sidecar-api";
import type { Context } from "effect";
import { Effect, Option, Result } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { AppServices } from "../services.ts";

/**
 * The latest transient (not derivable from the on-disk cache) build outcome
 * per repo root — `"ready"`/`"stale"`/`"absent"` are always re-derived from
 * `@repo/code-index`'s cache instead, so nothing here needs to track them.
 * Gone on sidecar restart, same as `generation-log.ts`'s map — there's no
 * in-flight build left to reattach to after a restart anyway.
 */
const buildStates = new Map<
	string,
	| { readonly kind: "building" }
	| { readonly kind: "failed"; readonly message: string }
>();

/**
 * The one decoded `CodeIndex` kept in memory per repo root, at whatever head
 * sha it was last decoded for. Decoding is real work (a single pass over
 * tens of thousands of occurrences — see `@repo/code-index`'s `decodeIndex`
 * doc), so a query following a `status` check that just decoded the same
 * repo+sha reuses it instead of repeating the pass. Superseded (not
 * accumulated) on every decode — only ever one repo root's worth of index
 * data needs to be resident at a time per repo, and holding stale entries
 * for repos nobody's looking at anymore would just leak memory.
 */
const decodedIndexes = new Map<
	string,
	{ readonly headSha: string; readonly index: CodeIndex }
>();

/**
 * Repos already confirmed to have a `tsconfig*.json` somewhere, or confirmed
 * not to — a directory walk on every `status` poll (roughly once a second
 * while a build runs) would be wasteful for a fact that doesn't change
 * within a running session.
 */
const tsConfigPresence = new Map<string, boolean>();

/** Exported so `http.ts`'s `build` handler gates on the exact same (memoized) answer `resolveCodeIndexStatus` derives `"unsupported"` from — one source of truth for "does this repo have a tsconfig anywhere." */
export const isCodeIndexUnsupported = (
	repoRoot: string,
): Effect.Effect<boolean, never, FileSystem> =>
	Effect.gen(function* () {
		const cached = tsConfigPresence.get(repoRoot);
		if (cached !== undefined) return !cached;
		const present = yield* detectTsConfigPresence(repoRoot);
		tsConfigPresence.set(repoRoot, present);
		return !present;
	});

/** Decodes (or reuses an already-decoded) `CodeIndex` for `repoRoot` at exactly `headSha`. */
const getOrDecodeIndex = (
	dataDir: string,
	repoRoot: string,
	headSha: string,
): Effect.Effect<
	CodeIndex,
	CodeIndexCacheError | ScipDecodeError,
	FileSystem
> =>
	Effect.gen(function* () {
		const cached = decodedIndexes.get(repoRoot);
		if (cached !== undefined && cached.headSha === headSha) return cached.index;

		const bytes = yield* readIndexBytes(dataDir, repoRoot, headSha);
		const index = yield* decodeIndex(bytes);
		decodedIndexes.set(repoRoot, { headSha, index });
		return index;
	});

/**
 * The `CodeIndex` to actually query for `fileOccurrences`/`references` — the
 * current head's index when it's cached (the `"ready"` case), otherwise the
 * most recent cached one regardless of head sha (the `"stale"` case, still
 * useful data), otherwise `null` when nothing has ever built successfully.
 * Best-effort: a cache or decode failure here degrades to `null` rather than
 * failing the call, since both `fileOccurrences` and `references` already
 * treat "nothing available" as a legitimate empty response, not an error —
 * see their contract doc comments.
 */
export const resolveQueryableIndex = (
	repoRoot: string,
	headSha: string,
): Effect.Effect<CodeIndex | null, never, FileSystem> =>
	Effect.gen(function* () {
		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const ready = yield* findCachedIndex(dataDir, repoRoot, headSha).pipe(
			Effect.catch(() => Effect.succeed(Option.none())),
		);
		const info = Option.isSome(ready)
			? Option.some(ready.value)
			: yield* mostRecentCachedIndex(dataDir, repoRoot).pipe(
					Effect.catch(() => Effect.succeed(Option.none())),
				);
		if (Option.isNone(info)) return null;

		return yield* getOrDecodeIndex(dataDir, repoRoot, info.value.headSha).pipe(
			Effect.catch(() => Effect.succeed(null)),
		);
	});

/**
 * `status`'s full derivation: unsupported gates everything else, an
 * in-flight or just-failed build takes priority over what the cache alone
 * would say (a rebuild in progress should read `"building"`, not `"stale"`),
 * and otherwise the cache decides `"ready"` vs `"stale"` vs `"absent"` by
 * comparing `headSha` against what's actually cached.
 */
export const resolveCodeIndexStatus = (
	repoRoot: string,
	headSha: string,
): Effect.Effect<CodeIndexStatus, never, FileSystem> =>
	Effect.gen(function* () {
		if (yield* isCodeIndexUnsupported(repoRoot)) {
			return {
				status: "unsupported",
				headSha,
				indexedHeadSha: null,
				generatedAt: null,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}

		const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
		const buildState = buildStates.get(repoRoot);
		if (buildState !== undefined) {
			const info = yield* mostRecentCachedIndex(dataDir, repoRoot).pipe(
				Effect.catch(() => Effect.succeed(Option.none())),
			);
			return {
				status: buildState.kind,
				headSha,
				indexedHeadSha: Option.isSome(info) ? info.value.headSha : null,
				generatedAt: Option.isSome(info) ? info.value.generatedAt : null,
				documentCount: null,
				failureMessage:
					buildState.kind === "failed" ? buildState.message : null,
			} satisfies CodeIndexStatus;
		}

		const ready = yield* findCachedIndex(dataDir, repoRoot, headSha).pipe(
			Effect.catch(() => Effect.succeed(Option.none())),
		);
		if (Option.isSome(ready)) {
			const index = yield* getOrDecodeIndex(dataDir, repoRoot, headSha).pipe(
				Effect.option,
			);
			return {
				status: "ready",
				headSha,
				indexedHeadSha: headSha,
				generatedAt: ready.value.generatedAt,
				documentCount: Option.isSome(index) ? index.value.documentCount : null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}

		const stale = yield* mostRecentCachedIndex(dataDir, repoRoot).pipe(
			Effect.catch(() => Effect.succeed(Option.none())),
		);
		if (Option.isSome(stale)) {
			return {
				status: "stale",
				headSha,
				indexedHeadSha: stale.value.headSha,
				generatedAt: stale.value.generatedAt,
				documentCount: null,
				failureMessage: null,
			} satisfies CodeIndexStatus;
		}

		return {
			status: "absent",
			headSha,
			indexedHeadSha: null,
			generatedAt: null,
			documentCount: null,
			failureMessage: null,
		} satisfies CodeIndexStatus;
	});

/** Runs scip-typescript into a scratch file, caches the result on disk, and decodes it into the in-memory query cache — the actual work behind {@link startCodeIndexBuild}. */
const runCodeIndexBuild = (
	repoRoot: string,
	headSha: string,
): Effect.Effect<
	void,
	| ScipTypescriptInstallError
	| ScipTypescriptIndexError
	| CodeIndexCacheError
	| ScipDecodeError,
	FileSystem | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const dataDir = yield* getDataDirConfig().pipe(Effect.orDie);
			const fs = yield* FileSystem;
			const scratchDir = yield* fs
				.makeTempDirectoryScoped()
				.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
			const outputPath = join(scratchDir, "index.scip");

			yield* buildIndex(repoRoot, outputPath);

			const bytes = yield* fs
				.readFile(outputPath)
				.pipe(Effect.mapError((cause) => new CodeIndexCacheError({ cause })));
			yield* writeIndex(dataDir, repoRoot, headSha, bytes);

			const index = yield* decodeIndex(bytes);
			decodedIndexes.set(repoRoot, { headSha, index });
		}),
	);

const describeBuildFailure = (
	failure:
		| ScipTypescriptInstallError
		| ScipTypescriptIndexError
		| CodeIndexCacheError
		| ScipDecodeError,
): string => {
	switch (failure._tag) {
		case "ScipTypescriptIndexError":
			return failure.stderr.trim().length > 0
				? failure.stderr.trim()
				: `scip-typescript exited with code ${failure.exitCode}`;
		case "ScipTypescriptInstallError":
			return `couldn't provision scip-typescript (${failure.step}): ${String(failure.cause)}`;
		case "CodeIndexCacheError":
			return `couldn't write the index to the cache: ${String(failure.cause)}`;
		case "ScipDecodeError":
			return `couldn't decode the generated index: ${String(failure.cause)}`;
	}
};

/**
 * Starts a build for `repoRoot` and returns once it's registered, well
 * before the build itself finishes — `resolveCodeIndexStatus` is how a
 * caller watches progress from here. A repo already `"building"` is a
 * no-op: the existing run keeps going, nothing new is started. The
 * synchronous `buildStates.set` below, before any `await`, is what makes
 * that race-free — two `build` calls landing back to back both see whichever
 * state the first one set before either yields to the event loop.
 *
 * Uses `Effect.result` rather than letting a failure reject the promise —
 * unwrapping a rejected `Effect.runPromise`'s cause to find a specific
 * tagged error is exactly the Effect-internals-poking this sidesteps, same
 * reasoning as `walkthrough/generate.ts`'s `resolveContext`.
 */
export const startCodeIndexBuild = async (
	repoRoot: string,
	headSha: string,
	mainContext: Context.Context<AppServices>,
): Promise<void> => {
	if (buildStates.get(repoRoot)?.kind === "building") return;
	buildStates.set(repoRoot, { kind: "building" });

	void (async () => {
		const result = await Effect.runPromise(
			Effect.provide(
				Effect.result(runCodeIndexBuild(repoRoot, headSha)),
				mainContext,
			),
		);
		if (Result.isSuccess(result)) {
			buildStates.delete(repoRoot);
			return;
		}
		buildStates.set(repoRoot, {
			kind: "failed",
			message: describeBuildFailure(result.failure),
		});
	})();
};

/** Every occurrence in `path` from `index`, in the shape `codeIndex.fileOccurrences` reports — empty when `index` has no document for `path` (a non-TypeScript file, or one outside the indexed workspace). */
export const buildFileOccurrencesResponse = (
	index: CodeIndex,
	path: string,
): ReadonlyArray<CodeIndexOccurrence> => {
	const occurrences = occurrencesInDocument(index, path);
	if (occurrences === undefined) return [];
	return occurrences.map((occurrence) => ({
		line: occurrence.range.startLine,
		charStart: occurrence.range.startChar,
		charEnd: occurrence.range.endChar,
		symbolKey: occurrence.symbolKey,
		isDefinition: occurrence.isDefinition,
		hasDefinition: hasDefinition(index, occurrence.symbolKey),
		referenceCount: referenceCount(index, occurrence.symbolKey),
	}));
};

/** How many reference locations a single `references` call returns — a widely-referenced symbol (an exported type, a common utility) can have thousands; `totalReferenceCount` on the response still reports the real total so the UI can render "showing N of M." */
export const MAX_RETURNED_REFERENCES = 200;

/**
 * Everything `codeIndex.references` needs about `symbolKey` from `index`
 * alone — source line text isn't decided here since that needs a file read
 * (`Store.readCurrentFileContents`), which lives at the http.ts call site,
 * not in this state module. A `symbolKey` the index doesn't recognize
 * (stale from an old index, e.g.) degrades to the all-empty result below
 * rather than a special case — every field here is already exactly what an
 * unrecognized key naturally produces (no display name, no documentation,
 * no definition, zero references).
 */
export const buildReferencesPlan = (
	index: CodeIndex,
	symbolKey: string,
): {
	readonly displayName: string;
	readonly documentation: ReadonlyArray<string>;
	readonly definition: {
		readonly path: string;
		readonly line: number;
		readonly charStart: number;
		readonly charEnd: number;
	} | null;
	readonly totalReferenceCount: number;
	readonly returnedLocations: ReadonlyArray<{
		readonly path: string;
		readonly line: number;
		readonly charStart: number;
		readonly charEnd: number;
	}>;
} => {
	const key = symbolKey as SymbolKey;
	const definitions = definitionsOf(index, key);
	const references = referencesOf(index, key);
	const firstDefinition = definitions[0];

	return {
		displayName: displayNameOf(index, key) ?? "",
		documentation: documentationOf(index, key),
		definition:
			firstDefinition === undefined
				? null
				: {
						path: firstDefinition.path,
						line: firstDefinition.range.startLine,
						charStart: firstDefinition.range.startChar,
						charEnd: firstDefinition.range.endChar,
					},
		totalReferenceCount: references.length,
		returnedLocations: references
			.slice(0, MAX_RETURNED_REFERENCES)
			.map((location) => ({
				path: location.path,
				line: location.range.startLine,
				charStart: location.range.startChar,
				charEnd: location.range.endChar,
			})),
	};
};

/**
 * Groups `plan.returnedLocations` by file, attaching each one's source line
 * text from `fileContents` — `undefined`/a missing entry (the read failed,
 * or the path is gone) degrades to an empty `lineText` rather than dropping
 * the location: the position itself is still accurate and worth showing
 * even without a preview.
 */
export const groupReferencesByFile = (
	returnedLocations: ReturnType<
		typeof buildReferencesPlan
	>["returnedLocations"],
	fileContents: ReadonlyMap<string, Uint8Array>,
): ReadonlyArray<CodeIndexFileReferences> => {
	const decoder = new TextDecoder();
	const byPath = new Map<
		string,
		Array<CodeIndexFileReferences["references"][number]>
	>();

	for (const location of returnedLocations) {
		const bytes = fileContents.get(location.path);
		const lineText =
			bytes === undefined
				? ""
				: (decoder.decode(bytes).split("\n")[location.line] ?? "");
		const existing = byPath.get(location.path);
		const entry = {
			line: location.line,
			charStart: location.charStart,
			charEnd: location.charEnd,
			lineText,
		};
		if (existing === undefined) {
			byPath.set(location.path, [entry]);
		} else {
			existing.push(entry);
		}
	}

	return [...byPath.entries()].map(([path, references]) => ({
		path,
		references,
	}));
};

/** Assembles the full `codeIndex.references` wire response from a plan and its resolved file contents. */
export const buildReferencesResponse = (
	plan: ReturnType<typeof buildReferencesPlan>,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexReferencesResult => ({
	displayName: plan.displayName,
	documentation: plan.documentation,
	definition: plan.definition,
	files: groupReferencesByFile(plan.returnedLocations, fileContents),
	totalReferenceCount: plan.totalReferenceCount,
	returnedReferenceCount: plan.returnedLocations.length,
});
