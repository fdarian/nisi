/**
 * The wire bridge between `useChat`'s `Chat` instances (`@ai-sdk/react`) and
 * `chat.send`'s oRPC event-iterator stream. AI SDK's `ChatTransport.sendMessages`
 * must resolve to a `ReadableStream<UIMessageChunk>` — `ai` ships
 * `DirectChatTransport` (`ai/src/ui/direct-chat-transport.ts`) as its own
 * non-HTTP precedent, calling an `Agent` in-process and wrapping its
 * `.stream` into that same shape. This is the oRPC equivalent: `chat.send`
 * already streams AI SDK's own `UIMessageChunk`s verbatim
 * (`packages/sidecar-api/src/chat.ts`'s `ChatStreamChunk`, deliberately
 * `Schema.Unknown` passthrough — see that file's doc), so this is a pure
 * protocol adapter, not a projection the way the old `ChatEvent` union was.
 *
 * `sendMessages` only forwards the *newest* user message's text, not the
 * full `messages` history `DirectChatTransport` resends every turn —
 * `chat.send`'s multi-turn context lives server-side, in the thread's own
 * long-lived `HarnessAgentSession` (`sidecar/chat/sessions.ts`), so
 * replaying the whole conversation on every turn would double up context
 * the agent already has.
 *
 * `reconnectToStream` always returns `null` — threads are ephemeral
 * (in-memory only, gone on sidecar restart or a closed PR tab), so there's
 * nothing to resume, matching the contract's own doc comment.
 */
import type { ChatTransport, UIMessage, UIMessageChunk } from "ai";
import { isTextUIPart } from "ai";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { HarnessId } from "#/lib/walkthrough-data";

/**
 * What `ChatComposer`'s submit passes as `sendMessage`'s per-call
 * `options.body` — the only way a thread's first turn hands `harness`/`model`
 * down to the transport, since the transport itself is constructed once per
 * thread (`chat-store.ts`'s `getOrCreateChat`), before either is known.
 */
export type ChatSendBody = {
	readonly harness: HarnessId;
	readonly model: string | undefined;
};

function isChatSendBody(body: object | undefined): body is ChatSendBody {
	return body !== undefined && "harness" in body;
}

/** Joins a message's text parts — the only part type a user turn ever has (the composer is plain-text-only, see `chat-composer.tsx`). */
export function messageText(message: UIMessage): string {
	return message.parts
		.filter(isTextUIPart)
		.map((part) => part.text)
		.join("");
}

export function createOrpcChatTransport(
	orpc: SidecarQueryUtils,
	sessionId: string,
	threadId: string,
): ChatTransport<UIMessage> {
	return {
		async sendMessages({ messages, abortSignal, body }) {
			if (!isChatSendBody(body)) {
				throw new Error(
					"chat transport: sendMessage's options.body must carry { harness, model } — see chat-panel.tsx's onSend",
				);
			}
			const lastMessage = messages[messages.length - 1];
			if (lastMessage === undefined || lastMessage.role !== "user") {
				throw new Error(
					"chat transport: expected the newest message to be the user's turn",
				);
			}

			const stream = await orpc.chat.send.call(
				{
					sessionId,
					threadId,
					message: messageText(lastMessage),
					harness: body.harness,
					model: body.model,
				},
				{ signal: abortSignal },
			);

			// oRPC's `eventIterator` hands back an async iterable, not a
			// `ReadableStream` — `ChatTransport` is typed against the latter, so
			// this pumps one into the other rather than re-typing the contract.
			return new ReadableStream<UIMessageChunk>({
				async start(controller) {
					try {
						for await (const chunk of stream) {
							controller.enqueue(chunk as UIMessageChunk);
						}
						controller.close();
					} catch (error) {
						controller.error(error);
					}
				},
			});
		},
		async reconnectToStream() {
			return null;
		},
	};
}
