"use client";

import { Code2Icon } from "lucide-react";
import { useEffect, useState } from "react";
import {
	Command,
	CommandDialog,
	CommandDialogPopup,
	CommandEmpty,
	CommandFooter,
	CommandInput,
	CommandItem,
	CommandList,
	CommandPanel,
} from "#/components/ui/command";
import { Kbd } from "#/components/ui/kbd";
import { Separator } from "#/components/ui/separator";
import type { EditorInfo } from "#/hooks/use-available-editors";

type EditorPickerPaletteProps = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editors: readonly EditorInfo[];
	/** Fires once per pick — the caller (`files-changed-view.tsx`) both persists the choice as `preferredEditor` and opens the already-selected file in it. */
	onSelect: (editor: EditorInfo) => void;
};

/**
 * The "o e" leader shortcut's one-time prompt: `preferredEditor` is still
 * unset, but at least one editor is installed (`files-changed-view.tsx`
 * falls back to a toast instead when there's nothing to pick from). Same
 * `Command`/`CommandDialog` shell as the ⌘K command palette
 * (`command-palette.tsx`) and `OpenPullRequestPalette`, populated with the
 * live-probed editor list instead of static actions or a GitHub search.
 * Picking one both persists it as `preferredEditor` and opens the file, so
 * this only ever prompts once — every "o e" after the first goes straight
 * to the editor.
 */
export function EditorPickerPalette({
	open,
	onOpenChange,
	editors,
	onSelect,
}: EditorPickerPaletteProps): React.ReactElement {
	const [query, setQuery] = useState("");

	// Resets to a blank query every time the dialog opens — reopening a
	// stale palette should feel the same as opening it cold, same as
	// `OpenPullRequestPalette`'s identical reset effect.
	useEffect(() => {
		if (!open) return;
		setQuery("");
	}, [open]);

	const filtered = editors.filter((editor) =>
		editor.name.toLowerCase().includes(query.toLowerCase()),
	);

	return (
		<CommandDialog onOpenChange={onOpenChange} open={open}>
			<CommandDialogPopup>
				<CommandPanel>
					<Command
						filter={null}
						items={filtered}
						onValueChange={setQuery}
						value={query}
					>
						<CommandInput placeholder="Open in…" />
						<Separator />
						<CommandEmpty>No matching editors.</CommandEmpty>
						<CommandList>
							{(editor: EditorInfo) => (
								<CommandItem
									key={editor.id}
									onClick={() => onSelect(editor)}
									value={editor}
								>
									<div className="flex min-w-0 flex-1 items-center gap-2 pl-1">
										<Code2Icon className="size-4 shrink-0 text-muted-foreground" />
										{editor.name}
									</div>
								</CommandItem>
							)}
						</CommandList>
					</Command>
				</CommandPanel>
				<CommandFooter>
					<span className="flex items-center gap-1.5">
						<Kbd>↵</Kbd> Open & set as preferred
					</span>
				</CommandFooter>
			</CommandDialogPopup>
		</CommandDialog>
	);
}
