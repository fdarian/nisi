/**
 * Temporary Storybook coverage for `ChatTab`'s streaming spinner — added
 * only to visually check the loading indicator's spacing against a plain
 * icon+label button, without a live sidecar turn to actually stream one.
 * Not meant to stick around as permanent coverage — delete freely once
 * verified, same as `pr-merge-button.stories.tsx`'s own temporary coverage.
 *
 * `ChatTab` derives `isStreaming` off a real `Chat` instance
 * (`getOrCreateChat`), so the only way to show the spinner is to actually
 * drive one into `"streaming"` status: this story's fake `chat.send` yields
 * a `start` chunk then a `text-start` chunk — the first chunk that flips
 * `Chat`'s status to `"streaming"` (see `ai`'s `process-ui-message-stream.ts`)
 * — and then hangs forever, same shape `mock-orpc.ts`'s `neverSettles` uses
 * elsewhere for "never resolves".
 */
import { AsyncIteratorClass } from "@orpc/shared";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import type { SidecarClient } from "@repo/sidecar-api";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect, useState } from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { getOrCreateChat } from "#/lib/chat-store";
import { ChatTab } from "./chat-tab";

const SESSION_ID = "storybook-session";
const THREAD_ID = "storybook-thread";

function neverSettles(): Promise<never> {
	return new Promise<never>(() => {});
}

async function* startThenHang(): AsyncGenerator<unknown> {
	yield { type: "start" };
	yield { type: "text-start", id: "storybook-text" };
	await neverSettles();
}

function orpcStreaming(): SidecarQueryUtils {
	const client = {
		chat: {
			send: async () => {
				const source = startThenHang();
				return new AsyncIteratorClass(
					() => source.next(),
					async () => undefined,
				);
			},
			closeThread: async () => undefined,
		},
	} as unknown as SidecarClient;
	return createTanstackQueryUtils(client);
}

function StreamingChatTab(): React.ReactElement {
	const [orpc] = useState(orpcStreaming);

	useEffect(() => {
		void getOrCreateChat(orpc, SESSION_ID, THREAD_ID).sendMessage(
			{ text: "How does the diff review flow work?" },
			{ body: { harness: "claude-code", model: undefined } },
		);
	}, [orpc]);

	return (
		<ChatTab
			isActive={false}
			onClose={() => {}}
			onSelect={() => {}}
			orpc={orpc}
			sessionId={SESSION_ID}
			thread={{
				id: THREAD_ID,
				harness: null,
				model: undefined,
				references: [],
			}}
		/>
	);
}

const meta: Meta<typeof StreamingChatTab> = {
	title: "ChatDock/ChatTab",
	component: StreamingChatTab,
	parameters: { layout: "centered" },
};
export default meta;

type Story = StoryObj<typeof meta>;

export const Streaming: Story = {};
