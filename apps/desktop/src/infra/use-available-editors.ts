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
 * `loadEditors` resolves with the same list it writes into `editors`, so a
 * caller that needs the result of *this* probe (not just the next render's
 * state) — e.g. deciding whether to prompt for one at all — can `await` it
 * instead of racing a state update. On failure it still surfaces a toast and
 * resolves to `[]`, the same "nothing to offer" outcome a genuinely empty
 * probe would produce.
 */
export function useAvailableEditors(): {
	editors: EditorInfo[];
	loadEditors: () => Promise<EditorInfo[]>;
} {
	const [editors, setEditors] = useState<EditorInfo[]>([]);

	const loadEditors = (): Promise<EditorInfo[]> =>
		invoke<EditorInfo[]>("list_available_editors")
			.then((result) => {
				setEditors(result);
				return result;
			})
			.catch((error: unknown) => {
				toastManager.add({
					title: "Failed to list available editors",
					description: error instanceof Error ? error.message : String(error),
					type: "error",
				});
				return [];
			});

	return { editors, loadEditors };
}

/**
 * Opens `path` (a file or directory) in the editor registered for `scheme`,
 * alongside `repoRoot` — the repo/PR's root, always passed even when `path`
 * already points at that same root. Only Zed's backing `open_in_editor`
 * branch (`editors/zed.rs`) uses `repoRoot`; every other editor still opens
 * via the `<scheme>://file/<path>` URL and ignores it. Surfaces a failed
 * `open_in_editor` invoke as a toast rather than swallowing it, matching how
 * failed refetches are surfaced elsewhere (`use-refetch-toasts.ts`).
 */
export function openInEditor(
	scheme: string,
	editorName: string,
	repoRoot: string,
	path: string,
): void {
	invoke("open_in_editor", { scheme, repoRoot, path }).catch(
		(error: unknown) => {
			toastManager.add({
				title: `Failed to open in ${editorName}`,
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		},
	);
}
