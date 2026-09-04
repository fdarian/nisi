import { basename } from "node:path";
import {
	Cause,
	Deferred,
	type Duration,
	Effect,
	Fiber,
	Queue,
	Ref,
	type Scope,
	Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveTsLspBinary } from "./binary.ts";
import {
	LspProcessError,
	LspProtocolError,
	LspRequestError,
	type TsLspBinaryResolutionError,
} from "./errors.ts";
import {
	autoResponderResult,
	classifyMessage,
	decodeFrames,
	decodeHover,
	decodeLocations,
	encodeFrame,
	type JsonRpcErrorPayload,
	type LspHover,
	type LspLocation,
	type LspPosition,
	pathToUri,
} from "./protocol.ts";
import {
	decodeSemanticTokens,
	type SemanticToken,
	type SemanticTokensLegend,
} from "./semantic-tokens.ts";

/**
 * The public surface: one `tsc --lsp --stdio` process, already initialized
 * against `rootPath`, exposing the four queries this package supports.
 * `spawnLspServer` is the only way to get one — there's no bare constructor,
 * since every one of these needs the `initialize` handshake (and its
 * negotiated semantic-tokens legend) to already be done before it's usable.
 */
export type LspServer = {
	readonly rootPath: string;
	readonly semanticTokensFull: (
		path: string,
	) => Effect.Effect<
		ReadonlyArray<SemanticToken>,
		LspRequestError | LspProtocolError
	>;
	readonly references: (
		path: string,
		position: LspPosition,
	) => Effect.Effect<
		ReadonlyArray<LspLocation>,
		LspRequestError | LspProtocolError
	>;
	readonly definition: (
		path: string,
		position: LspPosition,
	) => Effect.Effect<
		ReadonlyArray<LspLocation>,
		LspRequestError | LspProtocolError
	>;
	readonly hover: (
		path: string,
		position: LspPosition,
	) => Effect.Effect<LspHover | null, LspRequestError | LspProtocolError>;
};

/** How long a single request waits for a response before failing `LspRequestError({ reason: "timeout" })` — generous relative to every latency this package's AGENTS.md measured (worst case ~1s, a cold cross-package project load), so a real timeout means the server is genuinely stuck, not just busy. */
const DEFAULT_REQUEST_TIMEOUT: Duration.Input = "30 seconds";

/**
 * The full standard LSP (2023) semantic-token type/modifier lists, in the
 * order this package's AGENTS.md documents the TS7 server actually uses.
 * Declaring anything less negotiates a *smaller* legend (gotcha 2) — the
 * server then encodes every token's type/modifiers as indices into
 * whichever legend `initialize` settled on, so an incomplete declaration
 * here doesn't just miss types, it makes every index meaningless.
 */
const STANDARD_TOKEN_TYPES = [
	"namespace",
	"class",
	"enum",
	"interface",
	"struct",
	"typeParameter",
	"type",
	"parameter",
	"variable",
	"property",
	"enumMember",
	"decorator",
	"event",
	"function",
	"method",
	"macro",
	"label",
	"comment",
	"string",
	"keyword",
	"number",
	"regexp",
	"operator",
];

const STANDARD_TOKEN_MODIFIERS = [
	"declaration",
	"definition",
	"readonly",
	"static",
	"deprecated",
	"abstract",
	"async",
	"modification",
	"documentation",
	"defaultLibrary",
];

/** Only what the four queries below actually use — no `documentSymbol`, no range-limited semantic tokens, nothing speculative. */
const CLIENT_CAPABILITIES = {
	textDocument: {
		references: {},
		definition: {},
		hover: { contentFormat: ["markdown", "plaintext"] },
		semanticTokens: {
			requests: { full: true },
			tokenTypes: STANDARD_TOKEN_TYPES,
			tokenModifiers: STANDARD_TOKEN_MODIFIERS,
			formats: ["relative"],
		},
	},
	general: { positionEncodings: ["utf-16"] },
};

type PendingMap = Map<number, Deferred.Deferred<unknown, JsonRpcErrorPayload>>;

/** Everything `releaseServer` needs that `LspServer` itself doesn't expose — kept separate so the public type stays exactly the four queries. */
type InternalServer = {
	readonly rootPath: string;
	readonly handle: ChildProcessSpawner.ChildProcessHandle;
	readonly readerFiber: Fiber.Fiber<void, never>;
	readonly writerFiber: Fiber.Fiber<void, never>;
	readonly request: ReturnType<typeof makeRequest>;
	readonly legend: SemanticTokensLegend;
};

/**
 * Spawns `tsc --lsp --stdio` rooted at `rootPath`, completes the
 * `initialize`/`initialized` handshake, and returns a ready-to-query
 * `LspServer` — scoped, so the process (and its stdio pump fibers) are torn
 * down when the caller's `Scope` closes; see `releaseServer` for the
 * shutdown sequence. Deliberately never sends `textDocument/didOpen` for
 * anything queried through the returned server — this package's AGENTS.md
 * documents why that's safe (the server reads files off disk given
 * `rootUri`) and measurably faster.
 */
export const spawnLspServer = (
	rootPath: string,
): Effect.Effect<
	LspServer,
	TsLspBinaryResolutionError | LspProcessError,
	Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.acquireRelease(acquireServer(rootPath), releaseServer).pipe(
		Effect.map((server) =>
			buildLspServer(server.rootPath, server.request, server.legend),
		),
	);

const acquireServer = (
	rootPath: string,
): Effect.Effect<
	InternalServer,
	TsLspBinaryResolutionError | LspProcessError,
	ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
	Effect.gen(function* () {
		const binary = yield* resolveTsLspBinary();

		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const handle = yield* spawner
			.spawn(ChildProcess.make(binary, ["--lsp", "--stdio"], { cwd: rootPath }))
			.pipe(
				Effect.mapError(
					(cause) => new LspProcessError({ step: "spawn", cause }),
				),
			);

		const outbound = yield* Queue.unbounded<Uint8Array>();
		const pending = yield* Ref.make<PendingMap>(new Map());
		const nextId = yield* Ref.make(0);
		const inboundBuffer = yield* Ref.make<Buffer>(Buffer.alloc(0));

		// `forkScoped`, not a bare fork: these pumps must live exactly as long
		// as the `Scope` this whole server is acquired against, independent of
		// whichever fiber happens to be running this `Effect.gen` block when it
		// returns — `releaseServer` also interrupts both explicitly, but that's
		// belt-and-suspenders, not what actually bounds their lifetime.
		const writerFiber = yield* Stream.run(
			Stream.fromQueue(outbound),
			handle.stdin,
		).pipe(
			Effect.catchCause((cause) =>
				Effect.logError("lsp stdin writer stopped", { rootPath, cause }),
			),
			Effect.forkScoped,
		);
		const readerFiber = yield* Stream.runForEach(handle.stdout, (chunk) =>
			onStdoutChunk(chunk, inboundBuffer, pending, outbound),
		).pipe(
			Effect.catchCause((cause) =>
				Effect.logError("lsp stdout reader stopped", { rootPath, cause }),
			),
			Effect.forkScoped,
		);

		const request = makeRequest(outbound, pending, nextId);

		const initializeResult = yield* request(
			"initialize",
			{
				processId: process.pid,
				rootUri: pathToUri(rootPath),
				capabilities: CLIENT_CAPABILITIES,
				workspaceFolders: [
					{ uri: pathToUri(rootPath), name: basename(rootPath) },
				],
			},
			DEFAULT_REQUEST_TIMEOUT,
		).pipe(
			Effect.mapError(
				(cause) => new LspProcessError({ step: "initialize", cause }),
			),
		);

		// Both of these are fundamental protocol invariants every query below
		// assumes, not conditions a caller could meaningfully recover from —
		// see this package's AGENTS.md gotchas 2 and 3. `Effect.sync`'s thunk
		// throwing surfaces as a defect, which is the point: this server
		// disagreeing with either assumption means the client is wrong, not
		// that the caller did something wrong.
		const legend = yield* Effect.sync(() => extractLegend(initializeResult));
		yield* Effect.sync(() => assertUtf16PositionEncoding(initializeResult));

		yield* Queue.offer(
			outbound,
			encodeFrame({ jsonrpc: "2.0", method: "initialized", params: {} }),
		);

		return { rootPath, handle, readerFiber, writerFiber, request, legend };
	});

/**
 * Best-effort graceful shutdown: `shutdown`/`exit` written straight to
 * `handle.stdin` (not through the outbound queue — `writerFiber` is
 * interrupted below, and forked-fiber interruption during scope teardown
 * isn't ordered against this finalizer, so routing through the queue could
 * silently drop both messages) followed by a short grace period, then a
 * hard kill if the process is still alive. No response is awaited for
 * `shutdown` — `readerFiber` is interrupted in the same breath, so nothing
 * would observe it arriving anyway. Never fails: this only ever runs during
 * cleanup, where the process misbehaving further is expected, not
 * exceptional.
 */
const releaseServer = (server: InternalServer): Effect.Effect<void> =>
	Effect.gen(function* () {
		yield* Stream.run(
			Stream.make(
				encodeFrame({
					jsonrpc: "2.0",
					id: "lsp-client-shutdown",
					method: "shutdown",
					params: null,
				}),
				encodeFrame({ jsonrpc: "2.0", method: "exit" }),
			),
			server.handle.stdin,
		).pipe(Effect.ignore);

		yield* Effect.sleep("300 millis");
		yield* Fiber.interrupt(server.readerFiber);
		yield* Fiber.interrupt(server.writerFiber);

		const stillRunning = yield* server.handle.isRunning.pipe(
			Effect.orElseSucceed(() => false),
		);
		if (stillRunning) {
			yield* server.handle.kill().pipe(Effect.ignore);
		}
	});

const onStdoutChunk = (
	chunk: Uint8Array,
	bufferRef: Ref.Ref<Buffer>,
	pendingRef: Ref.Ref<PendingMap>,
	outbound: Queue.Queue<Uint8Array>,
): Effect.Effect<void, LspProtocolError> =>
	Effect.gen(function* () {
		const previous = yield* Ref.get(bufferRef);
		const combined = Buffer.concat([previous, Buffer.from(chunk)]);
		const { messages, rest } = yield* Effect.try({
			try: () => decodeFrames(combined),
			catch: (cause) =>
				new LspProtocolError({
					raw: combined.toString("utf8").slice(0, 2000),
					cause,
				}),
		});
		yield* Ref.set(bufferRef, rest);
		yield* Effect.forEach(
			messages,
			(message) => dispatchMessage(message, pendingRef, outbound),
			{ discard: true },
		);
	});

const dispatchMessage = (
	message: unknown,
	pendingRef: Ref.Ref<PendingMap>,
	outbound: Queue.Queue<Uint8Array>,
): Effect.Effect<void, LspProtocolError> =>
	Effect.gen(function* () {
		const classified = yield* Effect.try({
			try: () => classifyMessage(message),
			catch: (cause) =>
				new LspProtocolError({
					raw: JSON.stringify(message).slice(0, 2000),
					cause,
				}),
		});

		if (classified.kind === "response" || classified.kind === "errorResponse") {
			const id = Number(classified.id);
			const pending = yield* Ref.get(pendingRef);
			const deferred = pending.get(id);
			if (deferred === undefined) return; // late or unrecognized reply — nothing is waiting on it
			yield* Ref.update(pendingRef, (map) => {
				const next = new Map(map);
				next.delete(id);
				return next;
			});
			yield* classified.kind === "response"
				? Deferred.succeed(deferred, classified.result)
				: Deferred.fail(deferred, classified.error);
			return;
		}

		if (classified.kind === "serverRequest") {
			const result = autoResponderResult(classified.method, classified.params);
			yield* Queue.offer(
				outbound,
				encodeFrame({ jsonrpc: "2.0", id: classified.id, result }),
			);
			return;
		}

		// notification — nothing this client acts on.
	});

const makeRequest =
	(
		outbound: Queue.Queue<Uint8Array>,
		pendingRef: Ref.Ref<PendingMap>,
		nextIdRef: Ref.Ref<number>,
	) =>
	(
		method: string,
		params: unknown,
		timeout: Duration.Input = DEFAULT_REQUEST_TIMEOUT,
	): Effect.Effect<unknown, LspRequestError> =>
		Effect.gen(function* () {
			const id = yield* Ref.updateAndGet(nextIdRef, (n) => n + 1);
			const deferred = yield* Deferred.make<unknown, JsonRpcErrorPayload>();
			yield* Ref.update(pendingRef, (map) => new Map(map).set(id, deferred));
			yield* Queue.offer(
				outbound,
				encodeFrame({ jsonrpc: "2.0", id, method, params }),
			);

			return yield* Deferred.await(deferred).pipe(
				Effect.timeout(timeout),
				Effect.catch(
					(error) =>
						new LspRequestError({
							method,
							reason: Cause.isTimeoutError(error)
								? "timeout"
								: "error-response",
							cause: error,
						}),
				),
				Effect.ensuring(
					Ref.update(pendingRef, (map) => {
						if (!map.has(id)) return map;
						const next = new Map(map);
						next.delete(id);
						return next;
					}),
				),
			);
		});

type InitializeResult = {
	readonly capabilities?: {
		readonly positionEncoding?: string;
		readonly semanticTokensProvider?: {
			readonly legend?: SemanticTokensLegend;
		};
	};
};

const extractLegend = (initializeResult: unknown): SemanticTokensLegend => {
	const legend = (initializeResult as InitializeResult).capabilities
		?.semanticTokensProvider?.legend;
	if (legend === undefined) {
		throw new Error(
			"server did not negotiate a semantic tokens legend — this client's initialize capabilities must declare the full textDocument.semanticTokens.tokenTypes/tokenModifiers set (see this package's AGENTS.md gotcha 2)",
		);
	}
	return legend;
};

const assertUtf16PositionEncoding = (initializeResult: unknown): void => {
	// The LSP spec defaults an omitted `positionEncoding` to "utf-16".
	const encoding =
		(initializeResult as InitializeResult).capabilities?.positionEncoding ??
		"utf-16";
	if (encoding !== "utf-16") {
		throw new Error(
			`server negotiated positionEncoding "${encoding}", but every position this client sends/receives is UTF-16 code units (see this package's AGENTS.md gotcha 3)`,
		);
	}
};

/** Lifts a query's raw JSON-RPC `result` through a (deliberately throwing) decoder, wrapping a bad shape into `LspProtocolError` rather than letting it escape as an unhandled exception. */
const decodeResult = <A>(
	result: unknown,
	decode: (raw: unknown) => A,
): Effect.Effect<A, LspProtocolError> =>
	Effect.try({
		try: () => decode(result),
		catch: (cause) =>
			new LspProtocolError({
				raw: JSON.stringify(result).slice(0, 2000),
				cause,
			}),
	});

const buildLspServer = (
	rootPath: string,
	request: ReturnType<typeof makeRequest>,
	legend: SemanticTokensLegend,
): LspServer => ({
	rootPath,
	semanticTokensFull: (path) =>
		request("textDocument/semanticTokens/full", {
			textDocument: { uri: pathToUri(path) },
		}).pipe(
			Effect.flatMap((result) =>
				decodeResult(result, (raw) => {
					const data =
						(raw as { data?: ReadonlyArray<number> } | null)?.data ?? [];
					return decodeSemanticTokens(data, legend);
				}),
			),
		),
	references: (path, position) =>
		request("textDocument/references", {
			textDocument: { uri: pathToUri(path) },
			position,
			context: { includeDeclaration: true },
		}).pipe(Effect.flatMap((result) => decodeResult(result, decodeLocations))),
	definition: (path, position) =>
		request("textDocument/definition", {
			textDocument: { uri: pathToUri(path) },
			position,
		}).pipe(Effect.flatMap((result) => decodeResult(result, decodeLocations))),
	hover: (path, position) =>
		request("textDocument/hover", {
			textDocument: { uri: pathToUri(path) },
			position,
		}).pipe(Effect.flatMap((result) => decodeResult(result, decodeHover))),
});
