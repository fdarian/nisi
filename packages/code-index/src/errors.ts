import { Schema } from "effect";

/**
 * A SCIP symbol string didn't match the grammar in `scip.proto`'s `<symbol>`
 * production (`symbol.ts`'s `parseSymbol`), or an `Occurrence.range` wasn't
 * the 3- or 4-element deprecated form scip-typescript actually emits
 * (`decode.ts`'s `decodeRange`). Both are decode-time invariant violations
 * against data scip-typescript itself produced — not a user-facing outcome,
 * so callers surface `raw`/`cause` rather than trying to recover.
 */
export class ScipDecodeError extends Schema.TaggedError<ScipDecodeError>()(
	"ScipDecodeError",
	{
		raw: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Failed to provision a `scip-typescript` binary to spawn — either the
 * pinned-copy install (`bootstrap.ts`'s `npm install` into
 * `~/.nisi/tools/scip-typescript`) itself failed, or the installed
 * package's own `package.json` couldn't be read to find its entry script.
 */
export class ScipTypescriptInstallError extends Schema.TaggedError<ScipTypescriptInstallError>()(
	"ScipTypescriptInstallError",
	{
		step: Schema.Literals(["install", "resolve-entry"]),
		cause: Schema.Defect(),
	},
) {}

/**
 * `scip-typescript index` failed to spawn at all (`exitCode: null`, `cause`
 * the underlying `PlatformError`) or exited nonzero (`cause` a plain `Error`
 * describing it, `stderr` its own output). Per the established behavior
 * against this indexer, stderr output alone (e.g. its harmless empty-`files`
 * tsconfig warning) is never a failure on its own — only a nonzero exit
 * code, or a failure to spawn in the first place, is.
 */
export class ScipTypescriptIndexError extends Schema.TaggedError<ScipTypescriptIndexError>()(
	"ScipTypescriptIndexError",
	{
		exitCode: Schema.NullOr(Schema.Number),
		stderr: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** A cache read/write/prune under `<dataDir>/code-index/` hit a filesystem error. */
export class CodeIndexCacheError extends Schema.TaggedError<CodeIndexCacheError>()(
	"CodeIndexCacheError",
	{
		cause: Schema.Defect(),
	},
) {}
