import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import { type ToolSet, toUIMessageStream, type UIMessageChunk } from "ai";
import { filterMeaninglessStreamErrors } from "../harness/stream-errors.ts";

/** Drains a `ReadableStream` via its reader rather than `yield*`/`for await` directly on it — the standalone `toUIMessageStream` below returns a plain `ReadableStream`, not AI SDK's own `AsyncIterableStream` (which attaches `Symbol.asyncIterator` itself; see `@ai-sdk/harness`'s `asAsyncIterableStream`), so async iteration isn't guaranteed without going through the reader explicitly. */
async function* drain<T>(stream: ReadableStream<T>): AsyncGenerator<T> {
	const reader = stream.getReader();
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) return;
			yield next.value;
		}
	} finally {
		reader.releaseLock();
	}
}

/**
 * Runs one user turn and forwards it as AI SDK's own `UIMessageChunk` stream.
 * `HarnessAgent.stream()` is declared as returning AI SDK's `StreamTextResult`,
 * but the real runtime value is `@ai-sdk/harness`'s `HarnessStreamTextResult`,
 * which implements `toUIMessageStream()` for real — there's no hand-rolled
 * `fullStream` projection here the way walkthrough's turn loop
 * (`generate.ts`) has one; AI SDK already owns turning a turn into the exact
 * chunk protocol `packages/sidecar-api/src/chat.ts`'s `ChatStreamChunk`
 * passes through untyped.
 *
 * This calls the *standalone* `toUIMessageStream({ stream, tools })` helper
 * rather than `result`'s own (deprecated) instance method of the same name,
 * because the instance method always converts *every* `fullStream` `"error"`
 * part into a visible `{ type: "error" }` chunk — including OpenCode's bare,
 * meaningless one (see `sidecar/harness/stream-errors.ts`'s
 * `describeStreamError`) — and `onError` only controls that chunk's message
 * text, not whether it's emitted at all. `filterMeaninglessStreamErrors`
 * drops that one part *before* conversion, on the raw `TextStreamPart`
 * stream, where "is this error real" can still be answered structurally
 * instead of by pattern-matching an already-flattened string. Every other
 * stream-exit surface on `HarnessStreamTextResult` throws `notSupportedYet`
 * — `pipeUIMessageStreamToResponse`, `pipeTextStreamToResponse`,
 * `toTextStreamResponse`, and the structured-output accessors
 * (`partialOutputStream`/`elementStream`/`output`) — verified against
 * `@ai-sdk/harness@1.0.54`'s compiled `HarnessStreamTextResult`; `.stream`/
 * `.fullStream` and `toUIMessageStream`/`toUIMessageStreamResponse` are the
 * ones that actually work.
 *
 * No `try`/`catch` here, deliberately: a construction failure
 * (`agent.stream()` itself rejecting) propagates as-is — a thrown error
 * tears the generator down the same way any other unhandled `chat.send`
 * failure does — and a real in-stream transport failure still reaches AI
 * SDK's own `{ type: "error" }` chunk conversion, since only the meaningless
 * one is filtered out above.
 */
export async function* streamChatTurn(options: {
	// biome-ignore lint/suspicious/noExplicitAny: the agent's tool-set/runtime-context type params aren't known statically here — only the untyped agent.stream() surface is ever called.
	readonly agent: HarnessAgent<any, any>;
	readonly session: HarnessAgentSession;
	readonly message: string;
	/** oRPC's own request `signal` — aborts when the client disconnects, e.g. the chat popup closing mid-stream. */
	readonly abortSignal: AbortSignal | undefined;
}): AsyncGenerator<UIMessageChunk> {
	const result = await options.agent.stream({
		session: options.session,
		prompt: options.message,
		abortSignal: options.abortSignal,
	});

	// `result.tools` exists at runtime — `HarnessStreamTextResult`'s
	// constructor sets it from the harness's merged builtin+user tool set,
	// and its own `toUIMessageStream()` instance method reads the same field
	// internally — but isn't declared on the public `StreamTextResult`
	// interface `agent.stream()` is typed to return, hence the cast.
	const tools = (result as unknown as { readonly tools: ToolSet }).tools;
	const chunkStream = toUIMessageStream({
		stream: filterMeaninglessStreamErrors(result.stream),
		tools,
	});
	yield* drain(chunkStream);
}
