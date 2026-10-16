import { app, shell } from "electron";
import { editorUrl } from "./editor-url";
import { openInZed } from "./zed";

/**
 * Editors probed for a registered `<scheme>://` handler, in the order they
 * should appear in the "Open in..." submenu. Xcode is deliberately excluded:
 * this menu hands a PR's repo root to a general-purpose code editor, it is
 * not a full IDE picker.
 */
const CANDIDATE_EDITORS = [
	{ id: "vscode", name: "VS Code" },
	{ id: "cursor", name: "Cursor" },
	{ id: "zed", name: "Zed" },
	{ id: "windsurf", name: "Windsurf" },
];

/** Asked live on every call, not cached, so installing an editor shows up the next time the dropdown opens. */
export function listAvailableEditors(): Array<{ id: string; name: string }> {
	return CANDIDATE_EDITORS.filter(
		(editor) => app.getApplicationNameForProtocol(`${editor.id}://`) !== "",
	);
}

async function openEditorUrl(scheme: string, path: string) {
	try {
		await shell.openExternal(editorUrl(scheme, path));
	} catch (e) {
		throw new Error(
			`failed to open ${scheme}: ${e instanceof Error ? e.message : e}`,
		);
	}
}

export async function openInEditor(target: {
	scheme: string;
	repoRoot: string;
	path: string;
}) {
	if (target.scheme === "zed") {
		return openInZed(target.repoRoot, target.path, (path) =>
			openEditorUrl("zed", path),
		);
	}
	return openEditorUrl(target.scheme, target.path);
}
