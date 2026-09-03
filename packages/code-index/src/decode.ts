import { fromBinary } from "@bufbuild/protobuf";
import {
	IndexSchema,
	type Occurrence,
	type SymbolInformation,
	SymbolRole,
} from "@scip-code/scip";
import { Effect } from "effect";
import { ScipDecodeError } from "./errors.ts";
import {
	deriveDisplayName,
	parseSymbol,
	type SymbolKey,
	symbolKeyOf,
} from "./symbol.ts";

/** A half-open `[start, end)` source range, 0-based, in UTF-16 code units — see this package's AGENTS.md on `positionEncoding`. */
export type OccurrenceRange = {
	readonly startLine: number;
	readonly startChar: number;
	readonly endLine: number;
	readonly endChar: number;
};

/** One symbol occurrence inside a single document — small on purpose (no raw symbol string, no per-occurrence documentation) since there are tens of thousands of these per index; anything derivable from `symbolKey` alone lives in `CodeIndex`'s per-symbol maps instead of being repeated per occurrence. */
export type CompactOccurrence = {
	readonly range: OccurrenceRange;
	readonly symbolKey: SymbolKey;
	readonly isDefinition: boolean;
};

/** A `CompactOccurrence` plus which document it's in — what `definitionsOf`/`referencesOf` return, since those span documents. */
export type OccurrenceLocation = {
	readonly path: string;
	readonly range: OccurrenceRange;
};

export type CodeIndex = {
	readonly projectRoot: string;
	readonly documentCount: number;
	readonly occurrencesByPath: ReadonlyMap<
		string,
		ReadonlyArray<CompactOccurrence>
	>;
	readonly definitionsByKey: ReadonlyMap<
		SymbolKey,
		ReadonlyArray<OccurrenceLocation>
	>;
	readonly referencesByKey: ReadonlyMap<
		SymbolKey,
		ReadonlyArray<OccurrenceLocation>
	>;
	readonly displayNameByKey: ReadonlyMap<SymbolKey, string>;
	readonly documentationByKey: ReadonlyMap<SymbolKey, ReadonlyArray<string>>;
};

const requireElement = (
	raw: ReadonlyArray<number>,
	index: number,
	symbolForError: string,
): number => {
	const value = raw[index];
	if (value === undefined) {
		throw new Error(
			`SCIP range missing element ${index} for occurrence of ${symbolForError}: ${JSON.stringify(raw)}`,
		);
	}
	return value;
};

/**
 * Decodes `Occurrence.range`'s deprecated `repeated int32` form — the only
 * one scip-typescript populates (`typedRange.case` is always `undefined`
 * from this indexer). Three elements is `[startLine, startChar, endChar]`
 * (the end line is inferred equal to the start line); four is
 * `[startLine, startChar, endLine, endChar]`.
 */
export const decodeRange = (
	raw: ReadonlyArray<number>,
	symbolForError: string,
): OccurrenceRange => {
	if (raw.length !== 3 && raw.length !== 4) {
		throw new Error(
			`expected a 3 or 4 element SCIP occurrence range for ${symbolForError}, got ${raw.length} elements: ${JSON.stringify(raw)}`,
		);
	}
	const startLine = requireElement(raw, 0, symbolForError);
	const startChar = requireElement(raw, 1, symbolForError);
	return raw.length === 3
		? {
				startLine,
				startChar,
				endLine: startLine,
				endChar: requireElement(raw, 2, symbolForError),
			}
		: {
				startLine,
				startChar,
				endLine: requireElement(raw, 2, symbolForError),
				endChar: requireElement(raw, 3, symbolForError),
			};
};

const isDefinitionOccurrence = (occurrence: Occurrence): boolean =>
	(occurrence.symbolRoles & SymbolRole.Definition) !== 0;

const pushLocation = (
	map: Map<SymbolKey, Array<OccurrenceLocation>>,
	key: SymbolKey,
	location: OccurrenceLocation,
): void => {
	const existing = map.get(key);
	if (existing === undefined) {
		map.set(key, [location]);
		return;
	}
	existing.push(location);
};

const recordDisplayName = (
	displayNameByKey: Map<SymbolKey, string>,
	key: SymbolKey,
	symbol: string,
): void => {
	if (displayNameByKey.has(key)) return;
	displayNameByKey.set(key, deriveDisplayName(parseSymbol(symbol)));
};

const recordDocumentation = (
	documentationByKey: Map<SymbolKey, ReadonlyArray<string>>,
	key: SymbolKey,
	info: SymbolInformation,
): void => {
	if (documentationByKey.has(key)) return;
	if (info.documentation.length === 0) return;
	documentationByKey.set(key, info.documentation);
};

const byRangeStart = (a: CompactOccurrence, b: CompactOccurrence): number =>
	a.range.startLine - b.range.startLine ||
	a.range.startChar - b.range.startChar;

/**
 * Decodes a `.scip` payload into a compact, queryable `CodeIndex`. Runs
 * `fromBinary(IndexSchema, bytes)` exactly once — the resulting protobuf
 * `Index` (62k+ occurrences as live objects, for this repo's own index) is
 * only ever referenced inside this function's body, so it's eligible for GC
 * the moment this returns; nothing it retains leaks into the returned
 * structure beyond primitives and the small `CompactOccurrence`/
 * `OccurrenceLocation` records built here.
 */
export const decodeIndex = (
	bytes: Uint8Array,
): Effect.Effect<CodeIndex, ScipDecodeError> =>
	Effect.try({
		try: () => {
			const protoIndex = fromBinary(IndexSchema, bytes);

			const occurrencesByPath = new Map<string, Array<CompactOccurrence>>();
			const definitionsByKey = new Map<SymbolKey, Array<OccurrenceLocation>>();
			const referencesByKey = new Map<SymbolKey, Array<OccurrenceLocation>>();
			const displayNameByKey = new Map<SymbolKey, string>();
			const documentationByKey = new Map<SymbolKey, ReadonlyArray<string>>();

			for (const doc of protoIndex.documents) {
				const compactOccurrences: Array<CompactOccurrence> = [];

				for (const occurrence of doc.occurrences) {
					// A syntax-highlighting-only occurrence (no symbol) carries
					// nothing a go-to-definition/find-references query needs.
					if (occurrence.symbol === "") continue;

					const range = decodeRange(occurrence.range, occurrence.symbol);
					const key = symbolKeyOf(doc.relativePath, occurrence.symbol);
					const isDefinition = isDefinitionOccurrence(occurrence);

					compactOccurrences.push({ range, symbolKey: key, isDefinition });
					pushLocation(isDefinition ? definitionsByKey : referencesByKey, key, {
						path: doc.relativePath,
						range,
					});
					recordDisplayName(displayNameByKey, key, occurrence.symbol);
				}

				compactOccurrences.sort(byRangeStart);
				occurrencesByPath.set(doc.relativePath, compactOccurrences);

				for (const info of doc.symbols) {
					const key = symbolKeyOf(doc.relativePath, info.symbol);
					recordDisplayName(displayNameByKey, key, info.symbol);
					recordDocumentation(documentationByKey, key, info);
				}
			}

			// External symbols are referenced from this workspace but defined in
			// a separate package's own index — never local (a local symbol can't
			// escape its document, let alone its workspace), so `""` is always
			// the right (ignored) `documentPath` here.
			for (const info of protoIndex.externalSymbols) {
				const key = symbolKeyOf("", info.symbol);
				recordDisplayName(displayNameByKey, key, info.symbol);
				recordDocumentation(documentationByKey, key, info);
			}

			return {
				projectRoot: protoIndex.metadata?.projectRoot ?? "",
				documentCount: protoIndex.documents.length,
				occurrencesByPath,
				definitionsByKey,
				referencesByKey,
				displayNameByKey,
				documentationByKey,
			} satisfies CodeIndex;
		},
		catch: (cause) =>
			new ScipDecodeError({ raw: `${bytes.byteLength} bytes`, cause }),
	});

/** Every occurrence in `path`, in reading order — the client-side hover map's data source. `undefined` for a path the index has no document for (outside the indexed workspace, or never touched by TypeScript). */
export const occurrencesInDocument = (
	index: CodeIndex,
	path: string,
): ReadonlyArray<CompactOccurrence> | undefined =>
	index.occurrencesByPath.get(path);

const rangeContains = (
	range: OccurrenceRange,
	line: number,
	character: number,
): boolean => {
	if (line < range.startLine || line > range.endLine) return false;
	if (range.startLine === range.endLine) {
		return character >= range.startChar && character < range.endChar;
	}
	if (line === range.startLine) return character >= range.startChar;
	if (line === range.endLine) return character < range.endChar;
	return true;
};

/** A coarse "how wide is this range" key, line span dominating character span — used only to prefer the narrowest of several occurrences that happen to overlap the same position. */
const rangeWidth = (range: OccurrenceRange): number =>
	(range.endLine - range.startLine) * 1_000_000 +
	(range.endChar - range.startChar);

/**
 * The occurrence at `path`'s `(line, character)` — half-open on both range
 * bounds, so a query exactly at `startChar` matches and one exactly at
 * `endChar` doesn't. When more than one occurrence covers the position (a
 * property access whose enclosing range wasn't emitted as a separate
 * occurrence, e.g.), the narrowest one wins, on the theory that it's the
 * innermost token under the cursor. `undefined` when nothing covers the
 * position, including when `path` itself isn't in the index.
 */
export const symbolAtPosition = (
	index: CodeIndex,
	path: string,
	line: number,
	character: number,
): CompactOccurrence | undefined => {
	const occurrences = index.occurrencesByPath.get(path);
	if (occurrences === undefined) return undefined;

	let best: CompactOccurrence | undefined;
	for (const occurrence of occurrences) {
		if (!rangeContains(occurrence.range, line, character)) continue;
		if (
			best === undefined ||
			rangeWidth(occurrence.range) < rangeWidth(best.range)
		) {
			best = occurrence;
		}
	}
	return best;
};

/** Every Definition-role occurrence of `key`, across every document — usually one, but the SCIP spec doesn't guarantee that (e.g. a forward declaration and its implementation). Empty when `key` is never defined in this index (an external symbol, or one that's only ever referenced). */
export const definitionsOf = (
	index: CodeIndex,
	key: SymbolKey,
): ReadonlyArray<OccurrenceLocation> => index.definitionsByKey.get(key) ?? [];

/** Every non-Definition occurrence of `key`, across every document — grouping by document, if wanted, is left to the caller (`decode.ts` stays flat/composable rather than baking in a display shape). */
export const referencesOf = (
	index: CodeIndex,
	key: SymbolKey,
): ReadonlyArray<OccurrenceLocation> => index.referencesByKey.get(key) ?? [];

/** Whether `key` has at least one Definition-role occurrence anywhere in the index. */
export const hasDefinition = (index: CodeIndex, key: SymbolKey): boolean =>
	(index.definitionsByKey.get(key)?.length ?? 0) > 0;

/** How many non-Definition occurrences `key` has, across every document. */
export const referenceCount = (index: CodeIndex, key: SymbolKey): number =>
	index.referencesByKey.get(key)?.length ?? 0;

/** `key`'s display name, derived at decode time from its descriptor chain (`symbol.ts`'s `deriveDisplayName`) — `undefined` only if `key` never appeared as either an occurrence or a `SymbolInformation` entry, which shouldn't happen for a key this package itself produced. */
export const displayNameOf = (
	index: CodeIndex,
	key: SymbolKey,
): string | undefined => index.displayNameByKey.get(key);

/** `key`'s markdown documentation strings (`SymbolInformation.documentation`) — empty when the symbol has none, which is common (most local variables, many internal terms). */
export const documentationOf = (
	index: CodeIndex,
	key: SymbolKey,
): ReadonlyArray<string> => index.documentationByKey.get(key) ?? [];
