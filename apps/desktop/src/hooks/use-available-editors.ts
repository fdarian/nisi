import { invoke } from "@tauri-apps/api/core";
import { useState } from "react";
import { toastManager } from "#/components/ui/toast";

/** An editor with a URL scheme registered in macOS Launch Services — see `editors.rs`'s `list_available_editors`. */
export type EditorInfo = {
	id: string;
	name: string;
};

/**
 * Editors registered to handle `<scheme>://` URLs, refreshed via `loadEditors`
 * rather than eagerly — call it when an "Open in..." submenu opens, so
 * installing/uninstalling an editor is reflected without an app restart.
 */
export function useAvailableEditors(): {
	editors: EditorInfo[];
	loadEditors: () => void;
} {
	const [editors, setEditors] = useState<EditorInfo[]>([]);

	const loadEditors = (): void => {
		invoke<EditorInfo[]>("list_available_editors")
			.then(setEditors)
			.catch((error: unknown) => {
				toastManager.add({
					title: "Failed to list available editors",
					description: error instanceof Error ? error.message : String(error),
					type: "error",
				});
			});
	};

	return { editors, loadEditors };
}

/**
 * Opens `path` (a file or directory) in the editor registered for `scheme`.
 * Surfaces a failed `open_in_editor` invoke as a toast rather than swallowing
 * it, matching how failed refetches are surfaced elsewhere
 * (`use-refetch-toasts.ts`).
 */
export function openInEditor(
	scheme: string,
	editorName: string,
	path: string,
): void {
	invoke("open_in_editor", { scheme, path }).catch((error: unknown) => {
		toastManager.add({
			title: `Failed to open in ${editorName}`,
			description: error instanceof Error ? error.message : String(error),
			type: "error",
		});
	});
}
