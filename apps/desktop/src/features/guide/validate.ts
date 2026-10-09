import type { GuideResult } from "@repo/sidecar-api";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { type GuideFile, uncoveredFiles } from "./areas";
import { evaluateGuide } from "./evaluate";
import { GUIDE_COMPONENTS } from "./guide-components";
import { type GuideCollector, GuideProvider } from "./guide-context";
import { parseLines } from "./refs";

/** A changed line range in the head file (1-based, inclusive); a pure deletion is the single line it sits before. */
export type ChangedRange = { start: number; end: number };

export type DiffFile = GuideFile & { changed: readonly ChangedRange[] };

const SHORT_SHA = 7;

function overlaps(range: ChangedRange, start: number, end: number): boolean {
	return range.start <= end && start <= range.end;
}

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
			!file.changed.some((range) =>
				overlaps(range, lines.startLine, lines.endLine),
			)
		) {
			const changed = file.changed
				.map((range) => `${range.start}-${range.end}`)
				.join(", ");
			problems.push(
				`Ref ${label}: those lines aren't in any diff hunk of the file (changed: ${changed === "" ? "none" : changed}). Cite changed lines, or drop \`lines\`.`,
			);
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
	};
	let html: string;
	try {
		const Guide = evaluateGuide(result.version, result.code);
		html = renderToString(
			createElement(
				GuideProvider,
				{
					value: {
						sessionId: "validate",
						files,
						changedPaths: new Set(files.map((file) => file.path)),
						checks: result.checks,
						headSha: result.headSha,
						selectedRef: null,
						selectRef: () => {},
						areaOrder: [],
						setAreaOrder: () => {},
						hoveredArea: null,
						setHoveredArea: () => {},
						collector,
					},
				},
				createElement(Guide, { components: GUIDE_COMPONENTS as never }),
			),
		).replace(/<!-- -->/g, "");
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
		const uncovered = uncoveredFiles(
			files,
			collector.areas.map((area) => area.paths),
		);
		if (uncovered.length > 0) {
			problems.push(
				`Changed files no Area covers (add their paths to an Area, or add an Area):\n${uncovered.map((file) => `  ${file.path}`).join("\n")}`,
			);
		}
	}
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
