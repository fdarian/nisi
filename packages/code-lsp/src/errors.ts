import { Schema } from "effect";

/**
 * Couldn't find an absolute path for the TypeScript 7 native LSP binary to
 * spawn. `NISI_TS_LSP_BIN` bypasses resolution entirely. Download failures,
 * unsupported platforms, and integrity mismatches preserve their distinct
 * strategy so callers can show the actual cause to the user.
 */
export class TsLspBinaryResolutionError extends Schema.TaggedError<TsLspBinaryResolutionError>()(
	"TsLspBinaryResolutionError",
	{
		strategy: Schema.Literals([
			"unsupported-platform",
			"download",
			"integrity-mismatch",
			"extract",
			"cache",
		]),
		cause: Schema.Defect(),
	},
) {}

/**
 * The `tsc --lsp --stdio` child process itself failed — either it never
 * spawned (`step: "spawn"`, `cause` the underlying `PlatformError`) or the
 * `initialize` handshake didn't complete (`step: "initialize"` — the
 * process exited before responding, or `initialize` itself came back as a
 * JSON-RPC error). Distinct from `LspRequestError`, which is a live
 * server's per-query failure, not a startup failure.
 */
export class LspProcessError extends Schema.TaggedError<LspProcessError>()(
	"LspProcessError",
	{
		step: Schema.Literals(["spawn", "initialize"]),
		cause: Schema.Defect(),
	},
) {}

/**
 * The server sent bytes that don't parse as the `Content-Length`-framed
 * JSON-RPC this client speaks, or a response's `result` didn't match the
 * shape the requesting query expects (see e.g. `protocol.ts`'s
 * `decodeLocation`, `semantic-tokens.ts`'s `decodeSemanticTokens`). Both are
 * decode-time invariant violations against a server this client itself
 * spawned and negotiated capabilities with — not a user-facing outcome to
 * recover from, just one to surface with enough (`raw`) to debug.
 */
export class LspProtocolError extends Schema.TaggedError<LspProtocolError>()(
	"LspProtocolError",
	{
		raw: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * One in-flight `request()` didn't resolve successfully — either the server
 * answered with a JSON-RPC `error` object (`reason: "error-response"`,
 * `cause` that object) or nothing came back within the timeout
 * (`reason: "timeout"`). Never raised for a *server-reported* empty result —
 * gotcha 6 in this package's AGENTS.md: out-of-range positions and
 * syntax-error files answer with a clean `[]`/`null`, not an error.
 */
export class LspRequestError extends Schema.TaggedError<LspRequestError>()(
	"LspRequestError",
	{
		method: Schema.String,
		reason: Schema.Literals(["timeout", "error-response"]),
		cause: Schema.Defect(),
	},
) {}
