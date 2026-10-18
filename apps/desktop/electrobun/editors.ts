import { Utils } from "electrobun/main";
import { editorUrl } from "../electron/editor-url";
import { openInZed } from "../electron/zed";

/**
 * Editors in the order they should appear in the "Open in..." submenu. Xcode is
 * deliberately excluded: this menu hands a PR's repo root to a general-purpose
 * code editor, it is not a full IDE picker.
 */
const CANDIDATE_EDITORS = [
	{ id: "vscode", name: "VS Code", bundleId: "com.microsoft.VSCode" },
	{ id: "cursor", name: "Cursor", bundleId: "com.todesktop.230313mzl4w4u92" },
	{ id: "zed", name: "Zed", bundleId: "dev.zed.Zed" },
	{ id: "windsurf", name: "Windsurf", bundleId: "com.exafunction.windsurf" },
];

async function isInstalled(bundleId: string): Promise<boolean> {
	const spotlight = Bun.spawn(
		["mdfind", `kMDItemCFBundleIdentifier == '${bundleId}'`],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(spotlight.stdout).text(),
		new Response(spotlight.stderr).text(),
		spotlight.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`mdfind exited ${exitCode}: ${stderr.trim()}`);
	}
	return stdout.trim() !== "";
}

/**
 * Electrobun has no "which app handles this scheme" query, so this asks
 * Spotlight whether the editor's app is installed instead. Asked live on every
 * call, so installing an editor shows up the next time the dropdown opens.
 */
export async function listAvailableEditors(): Promise<
	Array<{ id: string; name: string }>
> {
	const installed = await Promise.all(
		CANDIDATE_EDITORS.map((editor) => isInstalled(editor.bundleId)),
	);
	return CANDIDATE_EDITORS.filter((_editor, index) => installed[index]).map(
		(editor) => ({ id: editor.id, name: editor.name }),
	);
}

async function openEditorUrl(scheme: string, path: string) {
	const url = editorUrl(scheme, path);
	if (!Utils.openExternal(url)) {
		throw new Error(`failed to open ${scheme}: could not open ${url}`);
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
