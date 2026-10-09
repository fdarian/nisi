import type { GuideResult } from "@repo/sidecar-api";
import { Children, isValidElement, type ReactNode } from "react";
import { type GuideFile, hunkRange, uncoveredHunks } from "./areas";
import { GUIDE_COMPONENTS } from "./guide-components";
import type { GuideCollector } from "./guide-context";
import { Ref } from "./kit/ref";
import { parseLines } from "./refs";
import { renderGuideHtml } from "./static-render";

/** A changed file with the hunks `git diff` found; unlike the app's, they are always known here. */
export type DiffFile = GuideFile & {
	hunks: NonNullable<GuideFile["hunks"]>;
};

const SHORT_SHA = 7;

function problemsFromRefs(
	collector: GuideCollector,
	files: readonly DiffFile[],
): string[] {
	const byPath = new Map(files.map((file) => [file.path, file]));
	const seen = new Set<string>();
	const problems: string[] = [];
	for (const ref of collector.refs) {
		const label =
			ref.lines === undefined ? ref.path : `${ref.path}:${ref.lines}`;
		if (seen.has(label)) continue;
		seen.add(label);
		const file = byPath.get(ref.path);
		if (file === undefined) {
			problems.push(
				`Ref ${label} is not in the diff. Cite a changed file, or drop the Ref.`,
			);
			continue;
		}
		if (ref.lines === undefined) continue;
		const lines = parseLines(ref.lines);
		if (
			!file.hunks.some(
				(hunk) =>
					hunk.startLine <= lines.endLine && lines.startLine <= hunk.endLine,
			)
		) {
			const changed = file.hunks.map(hunkRange).join(", ");
			problems.push(
				`Ref ${label}: those lines aren't in any diff hunk of the file (changed: ${changed === "" ? "none" : changed}). Cite changed lines, or drop \`lines\`.`,
			);
		}
	}
	return problems;
}

const MAX_NOTE_SENTENCES = 2;

/** Stands in for a `Ref`, or a backticked path that autolinks into one. */
const LINK = "\u0001";
const PATH_LIKE =
	/^(?:[\w@.-]+\/)+[\w@.-]+(?::\d+(?:-\d+)?)?$|^[\w-]+\.[a-z]{1,5}(?::\d+(?:-\d+)?)?$/i;

/** A node tree's plain text without rendering it; links to code are `LINK`. */
function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) {
		if (node.type === Ref) return LINK;
		const inner = textOf(node.props.children);
		return node.type === GUIDE_COMPONENTS.code && PATH_LIKE.test(inner)
			? LINK
			: inner;
	}
	return "";
}

function sentenceCount(raw: string): number {
	// A link after a full stop ("… the pane. <Ref/>") points back at that sentence.
	const text = raw
		.replace(new RegExp(`(?<=[.!?])(?:\\s*${LINK})+(?=\\s|$)`, "g"), "")
		.replace(new RegExp(LINK, "g"), "ref");
	return text
		.replace(/\b(e\.g|i\.e|vs|etc)\./gi, "$1")
		.trim()
		.split(/(?<=[.!?])\s+/)
		.filter((sentence) => sentence !== "").length;
}

function problemsFromNotes(collector: GuideCollector): string[] {
	const problems: string[] = [];
	for (const note of collector.notes) {
		for (const block of Children.toArray(note.children)) {
			const isParagraph =
				typeof block === "string" ||
				(isValidElement(block) && block.type === GUIDE_COMPONENTS.p);
			if (!isParagraph) continue;
			const count = sentenceCount(textOf(block));
			if (count > MAX_NOTE_SENTENCES) {
				problems.push(
					`Note "${note.label}": a paragraph has ${count} sentences (the limit is ${MAX_NOTE_SENTENCES}). Split it into bullets, one point each.`,
				);
			}
		}
	}
	return problems;
}

function problemsFromHtml(html: string): string[] {
	const problems: string[] = [];
	if (/<h1[\s>]/.test(html)) {
		problems.push(
			"The guide has an h1. Remove it: the app already shows the PR's title, and the guide starts at `## Overview`.",
		);
	}
	if (!/<h2[^>]*>\s*Overview\s*<\/h2>/.test(html)) {
		problems.push("There is no `## Overview` section.");
	}
	return problems;
}

/**
 * Everything the app would complain about, plus what only the author can fix:
 * the guide is built and rendered exactly as the Guide tab does, with a
 * collector in the context so components report themselves. Returns a list of
 * problems for the agent; empty means the guide is good to hand over.
 */
export function validateGuide(
	result: GuideResult,
	files: readonly DiffFile[],
): string[] {
	if (result.kind === "missing")
		return [`There is no guide at ${result.path}.`];
	if (result.kind === "error")
		return [`The guide doesn't build:\n${result.message}`];

	const collector: GuideCollector = {
		areas: [],
		areasBlocks: 0,
		refs: [],
		stepAreas: [],
		notes: [],
	};
	let html: string;
	try {
		html = renderGuideHtml(result, files, { expanded: true, collector });
	} catch (cause) {
		return [
			`The guide fails to render: ${cause instanceof Error ? cause.message : String(cause)}`,
		];
	}

	const problems = problemsFromHtml(html);
	if (collector.areasBlocks === 0) {
		problems.push(
			"There is no `<Areas>`. The Overview groups the change into `<Area id title paths={[globs]}>` cards.",
		);
	} else {
		const ids = new Set(collector.areas.map((area) => area.id));
		for (const area of new Set(collector.stepAreas)) {
			if (!ids.has(area)) {
				problems.push(
					`A Sequence step names area "${area}", which no <Area> has as its id (ids: ${[...ids].join(", ")}).`,
				);
			}
		}
		const uncovered = uncoveredHunks(
			files,
			collector.areas.map((area) => area.paths),
		);
		if (uncovered.length > 0) {
			problems.push(
				`Changed code no Area covers (add the path to an Area's paths, claim the hunk with "path:lines", or add an Area):\n${uncovered.map((entry) => `  ${entry}`).join("\n")}`,
			);
		}
	}
	problems.push(...problemsFromNotes(collector));
	problems.push(...problemsFromRefs(collector, files));
	for (const check of result.checks) {
		if (check.sha !== result.headSha) {
			problems.push(
				`Check "${check.title}" was recorded at ${check.sha.slice(0, SHORT_SHA)}, but HEAD is ${result.headSha.slice(0, SHORT_SHA)}. Re-run it with check.ts.`,
			);
		}
	}
	return problems;
}
