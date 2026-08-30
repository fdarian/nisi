"use client";

/**
 * The message input: a Lexical plain-text editor (Enter sends, Shift+Enter
 * newlines) plus the harness/model picker, reusing
 * `HarnessModelCombobox` (`#/components/walkthrough/harness-model-combobox.tsx`)
 * as-is rather than building a second one — it already takes plain
 * `harnesses`/`value`/`onChange` props with no walkthrough-specific
 * coupling, so importing it here needed no changes.
 *
 * `PlainTextPlugin`, not `RichTextPlugin`: the Plain/Rich split only
 * decides which default `KEY_ENTER_COMMAND` handler and formatting
 * shortcuts get wired on top of the same core node tree — decorator nodes
 * (a future `@mention` chip) render identically under either, so plain text
 * doesn't foreclose that. `nodes: []` in `initialConfig` is exactly where
 * they'd be registered later.
 *
 * Rendered fresh per thread (`key={thread.id}` at the call site in
 * `chat-panel.tsx`) rather than kept alive across a thread switch — that's
 * what resets both the editor's contents and `selection` (the picker's
 * pending choice) for a newly-active thread with no extra bookkeeping here.
 */
import { LexicalComposer } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import { Link } from "@tanstack/react-router";
import type { ChatStatus } from "ai";
import {
	$createParagraphNode,
	$getRoot,
	COMMAND_PRIORITY_CRITICAL,
	KEY_ENTER_COMMAND,
} from "lexical";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	HarnessModelCombobox,
	type ModelSelection,
} from "#/components/walkthrough/harness-model-combobox";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useLastChatModel } from "#/lib/settings-data";
import { cn } from "#/lib/utils";
import { type HarnessId, useHarnesses } from "#/lib/walkthrough-data";

type ChatComposerProps = {
	/** `null` until the thread's first message locks it in — see `chat-store.ts`'s `ChatThreadMeta` doc. */
	threadHarness: HarnessId | null;
	threadModel: string | undefined;
	/** From `useChat({ chat })` — `"submitted"`/`"streaming"` both count as busy for this composer's own send/stop toggle, same as the old `thread.status === "streaming"` check covered both phases at once. */
	status: ChatStatus;
	orpc: SidecarQueryUtils;
	onSend: (text: string, harness: HarnessId, model: string | undefined) => void;
	onStop: () => void;
};

export function ChatComposer(props: ChatComposerProps): React.ReactElement {
	return (
		<LexicalComposer
			initialConfig={{
				namespace: "chat-composer",
				onError: (error: Error) => {
					throw error;
				},
				nodes: [],
			}}
		>
			<ComposerBody {...props} />
		</LexicalComposer>
	);
}

function ComposerBody({
	threadHarness,
	threadModel,
	status,
	orpc,
	onSend,
	onStop,
}: ChatComposerProps): React.ReactElement {
	const [editor] = useLexicalComposerContext();
	const [hasText, setHasText] = useState(false);
	const [selection, setSelection] = useState<ModelSelection | null>(null);
	const { harnesses } = useHarnesses(orpc);
	const [lastChatModel] = useLastChatModel(orpc);

	const isBusy = status === "submitted" || status === "streaming";
	// The picker only matters before the thread's live harness session
	// exists — `chatContract.send`'s doc: harness/model are ignored server
	// side once a thread's first message picked them.
	const needsPicker = threadHarness === null;
	const hasEnabledHarness = harnesses.some((harness) => harness.enabled);

	// Seeds the picker from the last harness/model the user actually sent a
	// message with, once — never overwrites a choice already made this
	// mount (`selection !== null` guard), and never trusts the persisted
	// pair blindly: the harness may since have been disabled, or the model
	// discovered from the CLI at runtime may no longer be in its live list.
	// Falls back to no selection rather than inventing a substitute. Runs as
	// an effect (not a lazy `useState` initializer) since `harnesses` loads
	// asynchronously and isn't available on first render.
	useEffect(() => {
		if (!needsPicker || lastChatModel === null || selection !== null) return;
		const harness = harnesses.find(
			(candidate) => candidate.id === lastChatModel.harness,
		);
		if (harness === undefined || !harness.enabled) return;
		const modelStillOffered = harness.models.some(
			(model) => model.id === lastChatModel.modelId,
		);
		if (!modelStillOffered) return;
		setSelection({ harness: harness.id, modelId: lastChatModel.modelId });
	}, [needsPicker, lastChatModel, harnesses, selection]);

	const submit = useCallback(() => {
		if (isBusy) return;
		const text = editor.read(() => $getRoot().getTextContent());
		if (text.trim().length === 0) return;
		const harness = threadHarness ?? selection?.harness ?? null;
		if (harness === null) return;
		const model = needsPicker ? selection?.modelId : threadModel;
		onSend(text, harness, model);
		editor.update(() => {
			const root = $getRoot();
			root.clear();
			const paragraph = $createParagraphNode();
			root.append(paragraph);
			paragraph.select();
		});
	}, [
		editor,
		isBusy,
		needsPicker,
		threadHarness,
		threadModel,
		selection,
		onSend,
	]);

	useEffect(() => {
		return editor.registerCommand<KeyboardEvent | null>(
			KEY_ENTER_COMMAND,
			(event) => {
				if (event?.shiftKey) return false;
				event?.preventDefault();
				submit();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
	}, [editor, submit]);

	const canSubmit = hasText && (threadHarness !== null || selection !== null);

	return (
		<div className="flex flex-col gap-2 border-t p-2">
			{needsPicker &&
				(hasEnabledHarness ? (
					<HarnessModelCombobox
						harnesses={harnesses}
						onChange={setSelection}
						value={selection}
					/>
				) : (
					<p className="text-muted-foreground text-xs">
						No harnesses enabled —{" "}
						<Link
							className={cn(
								buttonVariants({ variant: "link", size: "xs" }),
								"h-auto p-0",
							)}
							to="/settings"
						>
							enable one in Settings
						</Link>
						.
					</p>
				))}
			<div className="flex items-end gap-2 rounded-lg border border-input bg-background px-2.5 py-1.5 shadow-xs/5 transition-shadow focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
				<div className="relative min-h-8 flex-1">
					<PlainTextPlugin
						ErrorBoundary={LexicalErrorBoundary}
						contentEditable={
							<ContentEditable
								aria-placeholder="Ask about this PR…"
								className="max-h-40 min-h-8 resize-none overflow-y-auto text-sm outline-none"
								placeholder={
									<div className="pointer-events-none absolute top-0 left-0 text-muted-foreground text-sm">
										Ask about this PR…
									</div>
								}
							/>
						}
					/>
					<OnChangePlugin
						onChange={(editorState) =>
							editorState.read(() => {
								setHasText($getRoot().getTextContent().trim().length > 0);
							})
						}
					/>
				</div>
				{isBusy ? (
					<Button
						aria-label="Stop"
						onClick={onStop}
						size="icon-sm"
						variant="outline"
					>
						<SquareIcon />
					</Button>
				) : (
					<Button
						aria-label="Send"
						disabled={!canSubmit}
						onClick={submit}
						size="icon-sm"
					>
						<ArrowUpIcon />
					</Button>
				)}
			</div>
		</div>
	);
}
