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
	isLocalSymbolKey,
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
import { readWorktreeBlobContent, type WorktreeReadFailed } from "@repo/git";
import type {
	CodeIndexFileReferences,
	CodeIndexOccurrence,
	CodeIndexReferencesResult,
	CodeIndexSourceContext,
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
 * Reads `paths`' raw worktree bytes from `repoRoot`, unconditionally — no
 * `includeUncommitted`/`worktreeEligible` gate. `Store.readCurrentContent`
 * (the sidecar's one gate for "what does this path look like right now" —
 * `apps/desktop/sidecar/store.ts`) exists for diff/review semantics, where
 * "current" is a user preference (`includeUncommitted`). scip-typescript has
 * no such preference: it indexes whatever's physically on disk at
 * `repoRoot`, full stop (see `@repo/code-index`'s AGENTS.md). Reading a
 * code-index preview through the settings-gated path would describe a
 * *different* revision than the one the index's positions were computed
 * against whenever `includeUncommitted` is off and the worktree is dirty —
 * indistinguishable from genuine drift, and unrecoverable by rebuilding
 * (rebuilding re-indexes the same dirty tree; the preview would keep
 * reading the last commit; the mismatch would never clear). This function
 * is what `groupReferencesByFile`/`buildDefinitionContext` are read
 * through instead, so both halves of a peek agree on their source.
 *
 * Absent paths (deleted, never existed) are simply missing from the
 * result — same "absence is a value" contract `readWorktreeBlobContent`
 * itself uses.
 */
export const readWorktreeFileContents = (
	repoRoot: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<ReadonlyMap<string, Uint8Array>, WorktreeReadFailed> =>
	Effect.gen(function* () {
		const entries = yield* Effect.forEach(
			paths,
			(path) =>
				readWorktreeBlobContent(join(repoRoot, path)).pipe(
					Effect.map((content) => [path, content] as const),
				),
			{ concurrency: "unbounded" },
		);
		const contents = new Map<string, Uint8Array>();
		for (const [path, content] of entries) {
			if (Option.isSome(content)) contents.set(path, content.value);
		}
		return contents;
	});

/**
 * Everything `codeIndex.references` needs about `symbolKey` from `index`
 * alone — source line text isn't decided here since that needs a file read
 * (`readWorktreeFileContents`), which lives at the http.ts call site, not
 * in this state module. A `symbolKey` the index doesn't recognize (stale
 * from an old index, e.g.) degrades to the all-empty result below rather
 * than a special case — every field here is already exactly what an
 * unrecognized key naturally produces (no display name, no documentation,
 * no definition, zero references).
 */
export const buildReferencesPlan = (
	index: CodeIndex,
	symbolKey: string,
): {
	readonly displayName: string;
	/** Whether `symbolKey` is a local symbol — see `groupReferencesByFile`'s doc comment on why this changes how (or whether) drift can be detected for its locations. */
	readonly isLocal: boolean;
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
		isLocal: isLocalSymbolKey(key),
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
 * A real JS/TS source identifier — `_`/`$`/letters/digits, first character
 * not a digit. Used only as {@link isLocationStale}'s weak fallback for a
 * local symbol, whose `displayName` is scip-typescript's own per-document
 * counter (`"0"`, `"1"`, ...) rather than real text — this can't confirm the
 * slice is *the* expected token the way an exact `displayName` match can
 * for a global symbol, but it does catch gross drift (landing mid-JSX-tag,
 * on punctuation, on a blank line), which is what actually showed up live.
 */
const SIMPLE_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Whether `location`'s own `[charStart, charEnd)` slice of `lineText` still
 * looks like the symbol it's supposed to be — the drift detector this
 * module needs because the on-disk cache's staleness check
 * (`resolveCodeIndexStatus`) only tracks *committed* head-sha movement.
 * scip-typescript indexes the working tree at build time; any edit to the
 * file after that — committed or not — can shift every later line without
 * ever moving `headSha`, so a `"ready"` (or `"stale"`-but-still-queried)
 * index can silently disagree with what's actually on disk at a specific
 * position. Live-verified: a stale index recorded a `CodeIndexReference`
 * occurrence at line 382 of a file that had since gained ~20 lines above
 * it, so line 382 in the *current* file was a `</CollapsibleTrigger>` JSX
 * close tag — a different, unrelated line, not an off-by-one.
 *
 * A global symbol's `displayName` is real source text (the last descriptor
 * in its SCIP symbol string — see `symbol.ts`'s `deriveDisplayName`), so an
 * exact match against the slice is a reliable check. A local symbol has no
 * such ground truth, so it only gets the weaker {@link SIMPLE_IDENTIFIER}
 * sanity check.
 */
const isLocationStale = (
	lineText: string,
	charStart: number,
	charEnd: number,
	displayName: string,
	isLocal: boolean,
): boolean => {
	const slice = lineText.slice(charStart, charEnd);
	return isLocal ? !SIMPLE_IDENTIFIER.test(slice) : slice !== displayName;
};

/**
 * Groups `plan.returnedLocations` by file, attaching each one's source line
 * text from `fileContents` — `lineText` is `null` whenever it can't be
 * trusted: the read failed (the path is gone, or genuinely unreadable), the
 * line itself doesn't exist in the current content (the file got shorter),
 * or {@link isLocationStale} finds the expected symbol isn't actually at
 * that position anymore. The location itself (path/line/char) is kept and
 * shown regardless — "no reliable preview" is reported honestly (`null`)
 * rather than papered over with whatever text happens to sit at that
 * position, or with a fake empty-string fallback that's indistinguishable
 * from a genuinely blank line.
 */
export const groupReferencesByFile = (
	returnedLocations: ReturnType<
		typeof buildReferencesPlan
	>["returnedLocations"],
	fileContents: ReadonlyMap<string, Uint8Array>,
	displayName: string,
	isLocal: boolean,
): ReadonlyArray<CodeIndexFileReferences> => {
	const decoder = new TextDecoder();
	const byPath = new Map<
		string,
		Array<CodeIndexFileReferences["references"][number]>
	>();

	for (const location of returnedLocations) {
		const bytes = fileContents.get(location.path);
		const rawLine =
			bytes === undefined
				? undefined
				: decoder.decode(bytes).split("\n")[location.line];
		const lineText =
			rawLine === undefined ||
			isLocationStale(
				rawLine,
				location.charStart,
				location.charEnd,
				displayName,
				isLocal,
			)
				? null
				: rawLine;
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

/** Lines of context padded around the definition's own line — the peek panel shows roughly 8 lines total (3 before, the target line, 4 after). Mirrors what `code-index-peek-panel.tsx` used to slice client-side before this moved server-side. */
const DEFINITION_CONTEXT_LINES_BEFORE = 3;
const DEFINITION_CONTEXT_LINES_AFTER = 4;

/**
 * `plan.definition`'s surrounding source lines, drift-checked the same way
 * `groupReferencesByFile` checks each reference location — `null` when
 * there's no definition to begin with, its file couldn't be read, or
 * {@link isLocationStale} finds the expected symbol isn't actually at that
 * position anymore in `fileContents` (which must itself come from
 * {@link readWorktreeFileContents} — a mismatched source here is exactly
 * what produces a false drift verdict that a rebuild could never clear).
 */
const buildDefinitionContext = (
	definition: ReturnType<typeof buildReferencesPlan>["definition"],
	fileContents: ReadonlyMap<string, Uint8Array>,
	displayName: string,
	isLocal: boolean,
): CodeIndexSourceContext | null => {
	if (definition === null) return null;

	const bytes = fileContents.get(definition.path);
	if (bytes === undefined) return null;

	const contentLines = new TextDecoder().decode(bytes).split("\n");
	const targetLine = contentLines[definition.line];
	if (targetLine === undefined) return null;
	if (
		isLocationStale(
			targetLine,
			definition.charStart,
			definition.charEnd,
			displayName,
			isLocal,
		)
	) {
		return null;
	}

	const startLine = Math.max(
		0,
		definition.line - DEFINITION_CONTEXT_LINES_BEFORE,
	);
	const endLine = Math.min(
		contentLines.length - 1,
		definition.line + DEFINITION_CONTEXT_LINES_AFTER,
	);
	return { startLine, lines: contentLines.slice(startLine, endLine + 1) };
};

/**
 * Assembles the full `codeIndex.references` wire response from a plan and
 * its resolved file contents — `fileContents` must be read via
 * {@link readWorktreeFileContents} (never `Store.readCurrentContent`'s
 * `includeUncommitted`-gated path), and must include `plan.definition`'s
 * own path alongside every `returnedLocations` path, or `definitionContext`
 * degrades to `null` for a file that was simply never fetched.
 */
export const buildReferencesResponse = (
	plan: ReturnType<typeof buildReferencesPlan>,
	fileContents: ReadonlyMap<string, Uint8Array>,
): CodeIndexReferencesResult => ({
	displayName: plan.displayName,
	documentation: plan.documentation,
	definition: plan.definition,
	definitionContext: buildDefinitionContext(
		plan.definition,
		fileContents,
		plan.displayName,
		plan.isLocal,
	),
	files: groupReferencesByFile(
		plan.returnedLocations,
		fileContents,
		plan.displayName,
		plan.isLocal,
	),
	totalReferenceCount: plan.totalReferenceCount,
	returnedReferenceCount: plan.returnedLocations.length,
});
