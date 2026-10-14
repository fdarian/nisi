/** What a `Ref` points at: a repo-relative path, optionally narrowed to `lines` (`"12"` or `"12-30"`). */
export type GuideRef = { path: string; lines?: string };

const LINES = /^(\d+)(?:-(\d+))?$/;

export function isLines(text: string): boolean {
	return LINES.test(text);
}

export function parseLines(lines: string): {
	startLine: number;
	endLine: number;
} {
	const match = LINES.exec(lines);
	if (match === null) {
		throw new Error(`<Ref lines="${lines}"> isn't a line or "start-end" range`);
	}
	const startLine = Number.parseInt(match[1] as string, 10);
	const endLine =
		match[2] === undefined ? startLine : Number.parseInt(match[2], 10);
	if (endLine < startLine) {
		throw new Error(`<Ref lines="${lines}"> ends before it starts`);
	}
	return { startLine, endLine };
}

export function sameRef(a: GuideRef | null, b: GuideRef): boolean {
	return a !== null && a.path === b.path && a.lines === b.lines;
}

/**
 * Reads backticked text as a `Ref`: a changed path, or `path:lines` whose path
 * is changed. Anything else (a path outside the diff, a bare identifier) stays
 * plain code, so only links the pane can actually show get made.
 */
export function refFromCode(
	text: string,
	changedPaths: ReadonlySet<string>,
): GuideRef | null {
	if (changedPaths.has(text)) return { path: text };
	const colon = text.lastIndexOf(":");
	if (colon === -1) return null;
	const path = text.slice(0, colon);
	const lines = text.slice(colon + 1);
	return changedPaths.has(path) && isLines(lines) ? { path, lines } : null;
}
