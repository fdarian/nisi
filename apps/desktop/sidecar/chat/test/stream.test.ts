import { expect, test } from "bun:test";
import type { TextStreamPart, ToolSet } from "ai";
import { Effect, Logger } from "effect";
import { streamChatTurn } from "../stream.ts";

test("in-band chat errors preserve the message and log cause and thread ids", async () => {
	const error = new Error("bridge transport failed");
	const lines: string[] = [];
	const logger = Logger.make((options) => {
		lines.push(Logger.formatLogFmt.log(options));
	});
	const mainContext = Effect.runSync(
		Effect.context<never>().pipe(Effect.provide(Logger.layer([logger]))),
	);
	type Options = Parameters<typeof streamChatTurn>[0];
	const agent = {
		stream: async () => ({
			tools: {},
			stream: new ReadableStream<TextStreamPart<ToolSet>>({
				start(controller) {
					controller.enqueue({ type: "error", error });
					controller.close();
				},
			}),
		}),
	} as unknown as Options["agent"];
	const chunks = [];
	for await (const chunk of streamChatTurn({
		agent,
		session: {} as Options["session"],
		mainContext,
		sessionId: "review-session",
		threadId: "chat-thread",
		message: "hello",
		abortSignal: undefined,
	})) {
		chunks.push(chunk);
	}
	expect(chunks).toContainEqual({ type: "error", errorText: error.message });
	expect(lines).toHaveLength(1);
	expect(lines[0]).toContain("level=ERROR");
	expect(lines[0]).toContain("sessionId=review-session");
	expect(lines[0]).toContain("threadId=chat-thread");
	expect(lines[0]).toContain("stream.test.ts");
});
