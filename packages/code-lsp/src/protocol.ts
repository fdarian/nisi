import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Pure wire-level pieces of the JSON-RPC-over-stdio protocol `tsc --lsp
 * --stdio` speaks: `Content-Length`-framed message codec, classifying a
 * decoded message into what the client should do with it, the
 * server-initiated-request auto-responder (this package's AGENTS.md,
 * gotcha 1), and decoding the small handful of LSP result shapes the four
 * queries in `client.ts` actually consume. Nothing here touches a process
 * or an `Effect` — `client.ts` is the only caller, and it's the only place
 * that wraps these (deliberately throwing) decoders in `Effect.try`.
 */

export type JsonRpcId = number | string;

/** What `client.ts` does with one decoded JSON-RPC message — the whole point of separating this from the byte-level framing below is that it's a pure function of the message, testable without a process on the other end. */
export type ClassifiedMessage =
	| {
			readonly kind: "response";
			readonly id: JsonRpcId;
			readonly result: unknown;
	  }
	| {
			readonly kind: "errorResponse";
			readonly id: JsonRpcId;
			readonly error: JsonRpcErrorPayload;
	  }
	| {
			readonly kind: "serverRequest";
			readonly id: JsonRpcId;
			readonly method: string;
			readonly params: unknown;
	  }
	| {
			readonly kind: "notification";
			readonly method: string;
			readonly params: unknown;
	  };

export type JsonRpcErrorPayload = {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
};

/**
 * `message` is only ever `JSON.parse`d output from {@link decodeFrames}, so
 * this trusts the top-level shape (an object) but not which JSON-RPC
 * "flavor" it is — a response, the server asking *us* something, or a
 * one-way notification are told apart the same way the spec does: `id`
 * present or not, `method` present or not.
 */
export const classifyMessage = (message: unknown): ClassifiedMessage => {
	if (typeof message !== "object" || message === null) {
		throw new Error(
			`not a JSON-RPC message object: ${JSON.stringify(message)}`,
		);
	}
	const record = message as Record<string, unknown>;
	const hasId = "id" in record && record.id !== undefined;
	const hasMethod = "method" in record && typeof record.method === "string";

	if (hasId && hasMethod) {
		return {
			kind: "serverRequest",
			id: record.id as JsonRpcId,
			method: record.method as string,
			params: record.params,
		};
	}
	if (hasId) {
		if ("error" in record && record.error !== undefined) {
			return {
				kind: "errorResponse",
				id: record.id as JsonRpcId,
				error: record.error as JsonRpcErrorPayload,
			};
		}
		return {
			kind: "response",
			id: record.id as JsonRpcId,
			result: record.result,
		};
	}
	if (hasMethod) {
		return {
			kind: "notification",
			method: record.method as string,
			params: record.params,
		};
	}
	throw new Error(
		`JSON-RPC message has neither id nor method: ${JSON.stringify(message)}`,
	);
};

/**
 * The `result` to answer a server-initiated request with — gotcha 1 in this
 * package's AGENTS.md: leaving *any* of these unanswered deadlocks the
 * server (it blocks on the round trip, presenting as a hang with the child
 * burning zero CPU), so every method — including ones this list doesn't
 * name — gets a reply. `workspace/configuration` is the one case that isn't
 * a bare `null`: the server asks for `items.length` config values at once
 * and expects an array of that same length back.
 */
export const autoResponderResult = (
	method: string,
	params: unknown,
): unknown => {
	if (method === "workspace/configuration") {
		const items = (params as { items?: ReadonlyArray<unknown> } | undefined)
			?.items;
		return (items ?? []).map(() => null);
	}
	return null;
};

const CONTENT_LENGTH_HEADER = /Content-Length: (\d+)/i;
const HEADER_TERMINATOR = "\r\n\r\n";

/** `Content-Length: <n>\r\n\r\n<body>` — the body is the only part with meaningful non-ASCII content, so its byte length (not `message`'s JS string length) is what the header must carry. */
export const encodeFrame = (message: unknown): Buffer => {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(
		`Content-Length: ${body.byteLength}${HEADER_TERMINATOR}`,
		"ascii",
	);
	return Buffer.concat([header, body]);
};

export type FrameDecodeResult = {
	readonly messages: ReadonlyArray<unknown>;
	readonly rest: Buffer;
};

/**
 * Extracts every complete frame currently sitting in `buffer`, returning
 * whatever incomplete tail is left for the next chunk to complete — stdout
 * arrives as arbitrarily-sized chunks with no relationship to message
 * boundaries, so a header or body can straddle two `data` events. Throws on
 * a header that doesn't match `Content-Length: <n>` — a genuine protocol
 * violation from a server this client spawned itself, not a recoverable
 * input; `client.ts` is the only caller and wraps it in `Effect.try`.
 */
export const decodeFrames = (buffer: Buffer): FrameDecodeResult => {
	const messages: unknown[] = [];
	let cursor = buffer;
	while (true) {
		const headerEnd = cursor.indexOf(HEADER_TERMINATOR);
		if (headerEnd === -1) break;

		const header = cursor.subarray(0, headerEnd).toString("utf8");
		const match = CONTENT_LENGTH_HEADER.exec(header);
		if (!match) {
			throw new Error(`malformed LSP frame header: ${JSON.stringify(header)}`);
		}
		const contentLength = Number(match[1]);
		const bodyStart = headerEnd + HEADER_TERMINATOR.length;
		const bodyEnd = bodyStart + contentLength;
		if (cursor.length < bodyEnd) break; // body not fully arrived yet

		const body = cursor.subarray(bodyStart, bodyEnd).toString("utf8");
		messages.push(JSON.parse(body));
		cursor = cursor.subarray(bodyEnd);
	}
	return { messages, rest: cursor };
};

// --- LSP-domain value decoding -------------------------------------------

export type LspPosition = { readonly line: number; readonly character: number };
export type LspRange = {
	readonly start: LspPosition;
	readonly end: LspPosition;
};
/** `path` is always a plain filesystem path, never a `file://` URI — every query in `client.ts` takes paths in and hands paths back out, so a caller never has to touch URI encoding. */
export type LspLocation = { readonly path: string; readonly range: LspRange };

export const pathToUri = (path: string): string =>
	pathToFileURL(path).toString();
export const uriToPath = (uri: string): string => fileURLToPath(uri);

/**
 * `textDocument/definition` and `textDocument/references` both resolve to
 * this: `references` always answers `Location[]`; `definition` can answer a
 * single `Location`, a `Location[]`, a `LocationLink[]`, or `null` — folded
 * into one `ReadonlyArray<LspLocation>` (empty for `null`) so `client.ts`'s
 * `definition`/`references` share one decoder and one result shape.
 */
export const decodeLocations = (raw: unknown): ReadonlyArray<LspLocation> => {
	if (raw === null || raw === undefined) return [];
	const items = Array.isArray(raw) ? raw : [raw];
	return items.map(decodeLocation);
};

const decodeLocation = (item: unknown): LspLocation => {
	if (typeof item !== "object" || item === null) {
		throw new Error(
			`not a Location/LocationLink object: ${JSON.stringify(item)}`,
		);
	}
	const record = item as Record<string, unknown>;
	// `Location` carries `uri`/`range`; `LocationLink` carries `targetUri` plus
	// both `targetRange` (the whole declaration) and `targetSelectionRange`
	// (just the symbol name) — the selection range is the tighter, more
	// useful one when both are present.
	const uri = record.uri ?? record.targetUri;
	const range =
		record.range ?? record.targetSelectionRange ?? record.targetRange;
	if (typeof uri !== "string" || range === undefined) {
		throw new Error(
			`unrecognized Location/LocationLink shape: ${JSON.stringify(item)}`,
		);
	}
	return { path: uriToPath(uri), range: range as LspRange };
};

/** `textDocument/hover`'s `MarkupContent | MarkedString | MarkedString[]` `contents`, flattened to plain text — every caller of `client.ts`'s `hover` wants displayable text, not three shapes to branch on. */
export const decodeHoverContents = (contents: unknown): string => {
	if (typeof contents === "string") return contents;
	if (Array.isArray(contents))
		return contents.map(decodeHoverContents).join("\n\n");
	if (
		typeof contents === "object" &&
		contents !== null &&
		"value" in contents &&
		typeof (contents as { value: unknown }).value === "string"
	) {
		return (contents as { value: string }).value;
	}
	throw new Error(
		`unrecognized hover contents shape: ${JSON.stringify(contents)}`,
	);
};

export type LspHover = {
	readonly contents: string;
	readonly range: LspRange | null;
};

export const decodeHover = (raw: unknown): LspHover | null => {
	if (raw === null || raw === undefined) return null;
	if (typeof raw !== "object") {
		throw new Error(`not a Hover object: ${JSON.stringify(raw)}`);
	}
	const record = raw as { contents: unknown; range?: LspRange };
	return {
		contents: decodeHoverContents(record.contents),
		range: record.range ?? null,
	};
};
