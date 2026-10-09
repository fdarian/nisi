import { join } from "node:path";
import type { GuideIssue } from "@repo/sidecar-api";
import { htmlToText } from "../../src/features/guide/guide-text";
import { renderGuideHtml } from "../../src/features/guide/static-render";
import { validateGuide } from "../../src/features/guide/validate";
import { buildGuide, GUIDE_DIR } from "./build";
import { readGuideDiff } from "./diff";
import { appStylesheet } from "./preview-css";

type DiffSummary = { base: string; mergeBase: string; changedFiles: number };

/** `NeedsYou` reads tick state from `localStorage`, which a server render lacks. Installed for one synchronous render only, never left on the sidecar's globals. */
function withLocalStorage<T>(render: () => T): T {
	const key = "localStorage";
	const previous = Object.getOwnPropertyDescriptor(globalThis, key);
	Object.defineProperty(globalThis, key, {
		configurable: true,
		value: { getItem: () => null, setItem() {}, removeItem() {} },
	});
	try {
		return render();
	} finally {
		if (previous === undefined) Reflect.deleteProperty(globalThis, key);
		else Object.defineProperty(globalThis, key, previous);
	}
}

/** What `nisi guide validate` reports: the Guide tab's own checks plus what only the author can fix. */
export async function validateRepoGuide(
	repoRoot: string,
	base: string | undefined,
): Promise<DiffSummary & { issues: GuideIssue[] }> {
	const diff = await readGuideDiff(repoRoot, base);
	const built = await buildGuide(repoRoot);
	const problems = withLocalStorage(() => validateGuide(built, diff.files));
	return {
		base: diff.base,
		mergeBase: diff.mergeBase,
		changedFiles: diff.files.length,
		issues: problems.map((message) => ({ level: "error", message })),
	};
}

/**
 * The guide's rendered body, the app stylesheet to put it under, and the
 * plain-text reading of it. A guide that is missing, doesn't build or doesn't
 * render throws: the caller asked for a preview and has none to show.
 */
export async function previewRepoGuide(
	repoRoot: string,
	base: string | undefined,
	options: { expand: boolean; withCss: boolean },
): Promise<DiffSummary & { html: string; css?: string; text: string }> {
	const diff = await readGuideDiff(repoRoot, base);
	const built = await buildGuide(repoRoot);
	if (built.kind === "missing") {
		throw new Error(`There is no guide at ${built.path}.`);
	}
	if (built.kind === "error") {
		throw new Error(`The guide doesn't build:\n${built.message}`);
	}
	let html: string;
	try {
		html = withLocalStorage(() =>
			renderGuideHtml(built, diff.files, { expanded: options.expand }),
		);
	} catch (cause) {
		throw new Error(
			`The guide fails to render: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	return {
		base: diff.base,
		mergeBase: diff.mergeBase,
		changedFiles: diff.files.length,
		html,
		...(options.withCss
			? { css: await appStylesheet(join(repoRoot, GUIDE_DIR)) }
			: {}),
		text: htmlToText(html),
	};
}
