export {
	type CachedIndexInfo,
	findCachedIndex,
	listCachedIndexes,
	mostRecentCachedIndex,
	readIndexBytes,
	writeIndex,
} from "./cache.ts";
export {
	type CodeIndex,
	type CompactOccurrence,
	decodeIndex,
	decodeRange,
	definitionsOf,
	displayNameOf,
	documentationOf,
	hasDefinition,
	type OccurrenceLocation,
	type OccurrenceRange,
	occurrencesInDocument,
	referenceCount,
	referencesOf,
	symbolAtPosition,
} from "./decode.ts";
export {
	CodeIndexCacheError,
	ScipDecodeError,
	ScipTypescriptIndexError,
	ScipTypescriptInstallError,
} from "./errors.ts";
export { buildIndex, detectTsConfigPresence } from "./indexer.ts";
export {
	type Descriptor,
	type DescriptorSuffix,
	deriveDisplayName,
	isLocalSymbol,
	isLocalSymbolKey,
	type ParsedSymbol,
	parseSymbol,
	type SymbolKey,
	symbolKeyOf,
} from "./symbol.ts";
