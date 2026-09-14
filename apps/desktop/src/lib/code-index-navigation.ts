import type { CodeIndexReference } from "@repo/sidecar-api";

/** A reference location in the coordinates returned by the LSP (0-based). */
export type CodeIndexReferenceTarget = {
	path: string;
	line: number;
	charStart: number;
	charEnd: number;
};

export function codeIndexReferenceTarget(
	path: string,
	reference: Pick<CodeIndexReference, "line" | "charStart" | "charEnd">,
): CodeIndexReferenceTarget {
	return {
		path,
		line: reference.line,
		charStart: reference.charStart,
		charEnd: reference.charEnd,
	};
}

/** Converts the LSP's 0-based line to @pierre/diffs' displayed line number. */
export function codeIndexDisplayedLine(
	target: CodeIndexReferenceTarget,
): number {
	return target.line + 1;
}

export function codeIndexTargetLength(
	target: CodeIndexReferenceTarget,
): number | undefined {
	const length = target.charEnd - target.charStart;
	return length >= 0 ? length : undefined;
}
