import type { HarnessAgent, HarnessAgentSession } from "@ai-sdk/harness/agent";
import type { ChatEvent } from "@repo/sidecar-api";
import { describeStreamError } from "../harness/stream-errors.ts";

/**
 * Runs one user turn and projects `agent.stream()`'s `fullStream` into
 * `ChatEvent`s — the chat counterpart to walkthrough's turn loop
 * (`generate.ts`'s `for await (const part of result.fullStream)`), except
 * this forwards `text-delta` (the part walkthrough deliberately drops, since
 * its answer arrives via tool calls) and has no validate/retry loop: one
 * message in, one streamed answer out.
 */
export async function* streamChatTurn(options: {
	// biome-ignore lint/suspicious/noExplicitAny: same reason as `LiveChatSession.agent` — only the untyped `stream()` surface is ever called here.
	readonly agent: HarnessAgent<any, any>;
	readonly session: HarnessAgentSession;
	readonly message: string;
	/** oRPC's own request `signal` — aborts when the client disconnects, e.g. the chat popup closes mid-stream. */
	readonly abortSignal: AbortSignal | undefined;
}): AsyncGenerator<ChatEvent> {
	yield { type: "started" };

	try {
		const result = await options.agent.stream({
			session: options.session,
			prompt: options.message,
			abortSignal: options.abortSignal,
		});

		for await (const part of result.fullStream) {
			if (options.abortSignal?.aborted === true) return;
			if (part.type === "text-delta") {
				yield { type: "text-delta", delta: part.text };
				continue;
			}
			if (part.type === "tool-call") {
				yield {
					type: "tool-call",
					toolName: part.toolName,
					input: part.input,
				};
				continue;
			}
			if (part.type === "error") {
				const message = describeStreamError(part.error);
				if (message !== undefined) {
					yield { type: "error", message };
					return;
				}
			}
		}

		if (options.abortSignal?.aborted === true) return;
		yield { type: "done" };
	} catch (error) {
		// An abort tears the stream down the same way a real transport failure
		// would — checked here so an abort-triggered throw is never misreported
		// as an `error` event.
		if (options.abortSignal?.aborted === true) return;
		yield {
			type: "error",
			message: describeStreamError(error) ?? "The harness stream failed.",
		};
	}
}
