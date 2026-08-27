import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { UIMessageChunk } from "ai";

/**
 * Runs one user turn and forwards the result's own UI-message-chunk stream.
 * `HarnessAgent.stream()` is declared as returning AI SDK's `StreamTextResult`,
 * but the real runtime value is `@ai-sdk/harness`'s `HarnessStreamTextResult`,
 * which implements `toUIMessageStream()` for real — there's no hand-rolled
 * `fullStream` projection here the way walkthrough's turn loop
 * (`generate.ts`) has one; AI SDK already owns turning a turn into the exact
 * chunk protocol `packages/sidecar-api/src/chat.ts`'s `ChatStreamChunk`
 * passes through untyped.
 *
 * Every other stream-exit surface on `HarnessStreamTextResult` throws
 * `notSupportedYet` — `pipeUIMessageStreamToResponse`,
 * `pipeTextStreamToResponse`, `toTextStreamResponse`, and the
 * structured-output accessors (`partialOutputStream`/`elementStream`/
 * `output`) — verified against `@ai-sdk/harness@1.0.54`'s compiled
 * `HarnessStreamTextResult`. `toUIMessageStream`/`toUIMessageStreamResponse`
 * are the only working stream exits, which is why this reaches for the
 * former specifically rather than a more familiar-looking helper.
 *
 * No `try`/`catch` here, deliberately: a construction failure
 * (`agent.stream()` itself rejecting) or a transport failure surfaced
 * through the chunk stream both propagate as-is — a thrown error tears the
 * generator down the same way any other unhandled `chat.send` failure does,
 * and AI SDK's own `toUIMessageStream` already turns an in-stream transport
 * failure into a `{ type: "error" }` chunk on its own.
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
	yield* result.toUIMessageStream();
}
