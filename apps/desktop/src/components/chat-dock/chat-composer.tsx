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
	KEY_ESCAPE_COMMAND,
} from "lexical";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "#/components/ui/badge";
import { Button, buttonVariants } from "#/components/ui/button";
import {
	HarnessModelCombobox,
	type ModelSelection,
} from "#/components/walkthrough/harness-model-combobox";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import {
	type DiffSelectionReference,
	formatSelectionReference,
	formatSelectionReferenceShort,
} from "#/lib/diff-reference";
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
	/** Diff-pane selections attached via "Ask" — rendered as removable chips above the input and folded into the outgoing message text on send (see `submit` below). */
	references: readonly DiffSelectionReference[];
	/** Opaque counter — every change puts the caret back in the input. See `chat-store.ts`'s `SessionChatState.composerFocusRequest`. */
	focusRequest: number;
	onRemoveReference: (reference: DiffSelectionReference) => void;
	onClearReferences: () => void;
	onSend: (text: string, harness: HarnessId, model: string | undefined) => void;
	onStop: () => void;
};

/**
 * One removable "Ask"-attached reference, rendered above the composer
 * input. Shows the short (basename-only) form — a chip has nowhere near
 * enough width for a full repo-relative path (confirmed live: an
 * un-truncated long path ran the chip past the composer, past the popup,
 * and off the viewport entirely) — with the full `path#Lx-y` in `title` so
 * hovering still disambiguates two files sharing a basename. `max-w-full`
 * plus `truncate` on the label is a backstop for a single filename long
 * enough to overflow on its own even in short form; the line range itself
 * is never truncated, since that's the part that actually identifies the
 * selection.
 */
function ReferenceChip({
	reference,
	onRemove,
}: {
	reference: DiffSelectionReference;
	onRemove: () => void;
}): React.ReactElement {
	const short = formatSelectionReferenceShort(reference);
	const full = formatSelectionReference(reference);
	return (
		<Badge className="max-w-full gap-1 pr-1 font-mono" variant="outline">
			<span className="min-w-0 truncate" title={full}>
				{short}
			</span>
			<button
				aria-label={`Remove ${full}`}
				className="shrink-0 rounded-xs text-muted-foreground hover:text-foreground"
				onClick={onRemove}
				type="button"
			>
				<XIcon />
			</button>
		</Badge>
	);
}

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
	references,
	focusRequest,
	onRemoveReference,
	onClearReferences,
	onSend,
	onStop,
}: ChatComposerProps): React.ReactElement {
	const [editor] = useLexicalComposerContext();
	const [hasText, setHasText] = useState(false);
	const [selection, setSelection] = useState<ModelSelection | null>(null);
	const { harnesses } = useHarnesses(orpc);
	const [lastChatModel] = useLastChatModel(orpc);

	// Takes the caret on mount (opening the popup, expanding from minimized,
	// or switching threads — `chat-panel.tsx` keys `ChatComposer` by
	// `thread.id`) and again on every `focusRequest` bump, which is "Ask"'s
	// case: it attaches to the *already-mounted* active thread's composer, so
	// there's no mount to hang this off. `focusRequest` isn't read in the body
	// — its only job is to be a dependency that changes.
	//
	// Only sticks because `DiffSelectionPopover` disables Base UI's default
	// focus-restore-on-close (`finalFocus={false}`) — that would otherwise
	// return focus to wherever the drag gesture landed it a tick after this
	// runs.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
	useEffect(() => {
		editor.focus();
	}, [editor, focusRequest]);

	const isBusy = status === "submitted" || status === "streaming";
	// The picker only matters before the thread's live harness session
	// exists — `chatContract.send`'s doc: harness/model are ignored server
	// side once a thread's first message picked them.
	const needsPicker = threadHarness === null;
	const hasEnabledHarness = harnesses.some((harness) => harness.enabled);

	// Seeds the picker from the last harness/model actually sent with, once
	// (never overwrites a choice already made this mount). Re-validates
	// against the live harness list rather than trusting the persisted pair
	// blindly — a harness-only selection (`modelId: undefined`) is legitimate
	// and skips the model-membership check; a stored model id must still be
	// in the harness's live list.
	useEffect(() => {
		if (!needsPicker || lastChatModel === null || selection !== null) return;
		const harness = harnesses.find(
			(candidate) => candidate.id === lastChatModel.harness,
		);
		if (harness === undefined || !harness.enabled) return;
		const modelStillOffered =
			lastChatModel.modelId === undefined ||
			harness.models.some((model) => model.id === lastChatModel.modelId);
		if (!modelStillOffered) return;
		setSelection({ harness: harness.id, modelId: lastChatModel.modelId });
	}, [needsPicker, lastChatModel, harnesses, selection]);

	const submit = useCallback(() => {
		if (isBusy) return;
		const text = editor.read(() => $getRoot().getTextContent());
		// A no-op if the user has references attached but typed nothing —
		// same as an empty message being a no-op today. References stay
		// attached (not cleared) so a later send still includes them.
		if (text.trim().length === 0) return;
		const harness = threadHarness ?? selection?.harness ?? null;
		if (harness === null) return;
		const model = needsPicker ? selection?.modelId : threadModel;
		const outgoingText =
			references.length === 0
				? text
				: `${references.map(formatSelectionReference).join("\n")}\n\n${text}`;
		onSend(outgoingText, harness, model);
		if (references.length > 0) onClearReferences();
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
		references,
		onSend,
		onClearReferences,
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

	// Blurs the composer so focus returns to the main view — `j`/`k` and the
	// rest of `FilesChangedView`'s bare-key bindings are suppressed while this
	// contenteditable has focus (`isTextEntry` in `use-key-bindings.ts`), same
	// as the filter input's own first-Escape-blurs handling in
	// `files-sidebar.tsx`.
	useEffect(() => {
		return editor.registerCommand<KeyboardEvent>(
			KEY_ESCAPE_COMMAND,
			() => {
				editor.getRootElement()?.blur();
				return true;
			},
			COMMAND_PRIORITY_CRITICAL,
		);
	}, [editor]);

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
			{references.length > 0 && (
				<div className="flex flex-wrap gap-1">
					{references.map((reference) => (
						<ReferenceChip
							key={formatSelectionReference(reference)}
							onRemove={() => onRemoveReference(reference)}
							reference={reference}
						/>
					))}
				</div>
			)}
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
