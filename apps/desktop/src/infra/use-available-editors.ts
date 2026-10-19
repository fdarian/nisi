import { useState } from "react";
import { toastManager } from "#/components/ui/toast";
import { hasNative, native } from "#/infra/native";

/** An editor with a URL scheme registered in macOS Launch Services — see `electron/editors.ts`. */
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

	// Editors live on the Mac running nisi; a plain browser has nothing to open them with.
	const loadEditors = async (): Promise<EditorInfo[]> => {
		if (!hasNative()) return [];
		try {
			const result = await native().listAvailableEditors();
			setEditors(result);
			return result;
		} catch (error) {
			toastManager.add({
				title: "Failed to list available editors",
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
			return [];
		}
	};

	return { editors, loadEditors };
}

/**
 * Opens `path` (a file or directory) in the editor registered for `scheme`,
 * alongside `repoRoot` — the repo/PR's root, always passed even when `path`
 * already points at that same root. Only Zed's branch
 * (`electron/editors.ts`) uses `repoRoot`; every other editor still opens
 * via the `<scheme>://file/<path>` URL and ignores it. Surfaces a failed
 * `openInEditor` call as a toast rather than swallowing it, matching how
 * failed refetches are surfaced elsewhere (`use-refetch-toasts.ts`).
 */
export function openInEditor(
	scheme: string,
	editorName: string,
	repoRoot: string,
	path: string,
): void {
	native()
		.openInEditor({ scheme, repoRoot, path })
		.catch((error: unknown) => {
			toastManager.add({
				title: `Failed to open in ${editorName}`,
				description: error instanceof Error ? error.message : String(error),
				type: "error",
			});
		});
}
