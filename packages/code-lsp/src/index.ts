export { resolveTsLspBinary } from "./binary.ts";
export { type LspServer, spawnLspServer } from "./client.ts";
export {
	LspProcessError,
	LspProtocolError,
	LspRequestError,
	TsLspBinaryResolutionError,
} from "./errors.ts";
export { resolveProjectRoot } from "./project-root.ts";
export type {
	JsonRpcErrorPayload,
	JsonRpcId,
	LspHover,
	LspLocation,
	LspPosition,
	LspRange,
} from "./protocol.ts";
export {
	decodeSemanticTokens,
	type SemanticToken,
	type SemanticTokensLegend,
} from "./semantic-tokens.ts";
