/**
 * Storybook coverage for the chat dock's message rendering — reproduces the
 * horizontal-overflow bug (long fenced code, long URLs, long unbroken
 * tokens) without a live sidecar or a real streamed reply. `MessageList`
 * (`chat-panel.tsx`) is the right unit: it only takes `messages` +
 * `status`/`repoRoot`, no orpc/thread/session plumbing.
 *
 * `ChatPanelFrame` below mirrors `ChatPanelBody`'s real DOM chain (a
 * fixed-width, `overflow-hidden` shell around a `scrollFade` `ScrollArea`)
 * rather than rendering `MessageList` bare — the bug this covers lives in
 * that ancestor chain (flex shrink, `ScrollArea`'s content sizing) as much
 * as in `MessageList` itself, so a bare render wouldn't reproduce it.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import type { ChatStatus, UIMessage } from "ai";
import { ScrollArea } from "#/components/ui/scroll-area";
import { MessageList } from "./chat-panel";
import {
	CHAT_PANEL_DEFAULT_WIDTH,
	CHAT_PANEL_MIN_WIDTH,
} from "./chat-panel-resize";

const LONG_SHELL_COMMAND =
	"bun node_modules/@rheya/build-config/run.mjs --target=darwin-arm64 --profile=release --skip-cache-verification-step --emit-source-maps --output-dir=./dist/darwin-arm64/release";

const FIXTURE_MESSAGES: readonly UIMessage[] = [
	{
		id: "msg-1",
		role: "user",
		parts: [
			{
				type: "text",
				text: `Something's wrong with the build.\n\nHere's the exact command I ran:\n${LONG_SHELL_COMMAND}`,
			},
		],
	},
	{
		id: "msg-2",
		role: "assistant",
		parts: [
			{
				// A deliberately long, space-free tool name — the step
				// row (`chat-trace.tsx`) needs to truncate at the panel's minimum width.
				type: "tool-runDiagnosticsWithAVeryLongToolNameThatHasNoSpacesForWrapTesting",
				toolCallId: "call-1",
				state: "input-available",
				input: { cwd: "/Users/example/code/mockingbird" },
			},
		],
	},
	{
		id: "msg-3",
		role: "assistant",
		parts: [
			{
				type: "text",
				text: [
					"Looking at the logs, a few things stand out:",
					"",
					"- The script calls `bunNodeModulesRheyaBuildConfigRunMjsWithAnExtremelyLongInlineIdentifierThatHasNoSpaces()` directly, which is unusual for this repo.",
					"- It also reads `process.env.SOME_VERY_LONG_ENVIRONMENT_VARIABLE_NAME_THAT_DOES_NOT_WRAP_ON_ITS_OWN_EITHER`.",
					"- Full details are in the run log: <https://github.com/risedle/mockingbird/blob/main/apps/desktop/sidecar/chat/sessions.ts#L128-L164?utm_source=chat&utm_medium=debug&utm_campaign=long-url-wrap-test>",
					"",
					"The build hash for this run is 4f8a1c9e7b2d3f5061728394a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9 — worth pasting into the bug report.",
					"",
					"Here's the full invocation:",
					"",
					"```bash",
					LONG_SHELL_COMMAND,
					"```",
				].join("\n"),
			},
		],
	},
];

const TRACE_MESSAGES: readonly UIMessage[] = [
	{
		id: "trace-1",
		role: "user",
		parts: [{ type: "text", text: "Why does the sidebar flicker?" }],
	},
	{
		id: "trace-2",
		role: "assistant",
		parts: [
			{ type: "step-start" },
			{
				type: "reasoning",
				state: "done",
				text: "The flicker is probably a remount.\nCheck the key first.",
			},
			{
				type: "tool-Read",
				toolCallId: "t-1",
				state: "output-available",
				input: {
					file_path: "/tmp/storybook-repo/src/sidebar/sidebar.tsx",
				},
				output: "",
			},
			{
				type: "tool-Bash",
				toolCallId: "t-2",
				state: "output-error",
				input: {
					description: "Run the sidebar tests",
					command: LONG_SHELL_COMMAND,
				},
				errorText: "exit 1",
			},
			{ type: "text", text: "It remounts because the **key** changes." },
			{
				type: "tool-Grep",
				toolCallId: "t-3",
				state: "input-available",
				input: { pattern: "key=\\{" },
			},
		],
	},
];

type ChatPanelFrameProps = {
	width: number;
	messages: readonly UIMessage[];
	status?: ChatStatus;
};

function ChatPanelFrame({
	width,
	messages,
	status = "ready",
}: ChatPanelFrameProps): React.ReactElement {
	return (
		<div
			className="flex flex-col overflow-hidden rounded-xl border bg-popover text-popover-foreground"
			style={{ width }}
		>
			<ScrollArea scrollFade style={{ height: 480 }}>
				<MessageList
					repoRoot="/tmp/storybook-repo"
					status={status}
					messages={messages}
				/>
			</ScrollArea>
		</div>
	);
}

const meta: Meta<typeof ChatPanelFrame> = {
	title: "ChatDock/MessageList",
	component: ChatPanelFrame,
	parameters: { layout: "centered", controls: { disable: true } },
	args: { messages: FIXTURE_MESSAGES },
};
export default meta;

type Story = StoryObj<typeof meta>;

/** The panel's default resize width (`CHAT_PANEL_DEFAULT_WIDTH`) — every long token, URL, and code block wraps instead of overflowing or scrolling sideways. */
export const DefaultWidth: Story = {
	args: { width: CHAT_PANEL_DEFAULT_WIDTH },
};

/** The panel's minimum resize width (`CHAT_PANEL_MIN_WIDTH`) — the worst case a user can actually drag to; wrapping has to hold here too. */
export const MinimumWidth: Story = {
	args: { width: CHAT_PANEL_MIN_WIDTH },
};

/** Tool and reasoning runs as collapsible groups, split by a text part; the last group is still running. */
export const Trace: Story = {
	args: { width: CHAT_PANEL_DEFAULT_WIDTH, messages: TRACE_MESSAGES },
	render: (args) => <ChatPanelFrame {...args} status="streaming" />,
};

/** Between sending and the first chunk of the reply. */
export const Thinking: Story = {
	args: {
		width: CHAT_PANEL_DEFAULT_WIDTH,
		messages: TRACE_MESSAGES.slice(0, 1),
		status: "submitted",
	},
};
