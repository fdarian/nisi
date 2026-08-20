import { Result, Schema } from "effect";
import type { Location, ReferenceBlock, Section } from "./schema.ts";
import { Walkthrough } from "./schema.ts";

/**
 * One problem found while parsing a walkthrough document, carrying the
 * 1-based line number (relative to the whole document) it occurred on. This
 * is the entire point of a markdown buffer over a JSON one: a JSON parse
 * failure gives a single character offset into an escaped blob, while this
 * gives the agent a line it can jump straight to.
 */
export type DocumentParseError = {
	readonly line: number;
	readonly message: string;
};

export type DocumentParseResult =
	| { readonly ok: true; readonly walkthrough: Walkthrough }
	| { readonly ok: false; readonly errors: ReadonlyArray<DocumentParseError> };

type Line = { readonly number: number; readonly text: string };

const toLines = (text: string): ReadonlyArray<Line> =>
	text
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((lineText, index) => ({ number: index + 1, text: lineText }));

const FENCE_OPEN = /^```references\s*$/;
const FENCE_CLOSE = /^```\s*$/;
const SECTION_HEADING = /^## (.*)$/;
const REFERENCE_BLOCK_HEADER = /^([^:\s]+):\s*(.+)$/;
/**
 * `(.+)` is greedy, so against `a/b:1-2:3-4` it consumes as much as possible
 * and only backtracks until `:(\d+)-(\d+)$` matches at the very end — i.e.
 * it binds the *last* `:start-end` in the line, which is exactly "parse the
 * path greedily from the left" for a path that itself contains a colon.
 */
const REFERENCE_LOCATION = /^-\s*(.+):(\d+)-(\d+)$/;

type FenceLocation = {
	readonly fenceLines: ReadonlyArray<Line> | undefined;
	readonly excludedLineNumbers: ReadonlySet<number>;
	readonly errors: ReadonlyArray<DocumentParseError>;
};

/**
 * Finds the document's single ` ```references ` fence. Zero or more than one
 * is an error; when there's more than one, the first pair is still parsed so
 * the rest of the document's errors surface in the same pass instead of
 * being hidden behind the fence-count error.
 */
const locateFence = (lines: ReadonlyArray<Line>): FenceLocation => {
	const openIndices = lines
		.map((line, index) => (FENCE_OPEN.test(line.text) ? index : -1))
		.filter((index) => index !== -1);

	if (openIndices.length === 0) {
		return {
			fenceLines: undefined,
			excludedLineNumbers: new Set(),
			errors: [
				{
					line: 1,
					message:
						"No ```references fenced block found — the document must contain exactly one.",
				},
			],
		};
	}

	const countError: ReadonlyArray<DocumentParseError> =
		openIndices.length > 1
			? [
					{
						line: lines[openIndices[1] as number]?.number ?? 1,
						message: `Found ${openIndices.length} \`\`\`references fenced blocks — the document must contain exactly one.`,
					},
				]
			: [];

	const openIndex = openIndices[0] as number;
	const closeOffset = lines
		.slice(openIndex + 1)
		.findIndex((line) => FENCE_CLOSE.test(line.text));

	if (closeOffset === -1) {
		return {
			fenceLines: undefined,
			excludedLineNumbers: new Set([(lines[openIndex] as Line).number]),
			errors: [
				...countError,
				{
					line: (lines[openIndex] as Line).number,
					message: "```references fence is never closed with ```.",
				},
			],
		};
	}

	const closeIndex = openIndex + 1 + closeOffset;
	const fenceLines = lines.slice(openIndex + 1, closeIndex);
	const excludedLineNumbers = new Set(
		lines.slice(openIndex, closeIndex + 1).map((line) => line.number),
	);

	return { fenceLines, excludedLineNumbers, errors: countError };
};

type SectionsResult = {
	readonly sections: ReadonlyArray<Section>;
	readonly errors: ReadonlyArray<DocumentParseError>;
};

/**
 * `^## ` opens a section; everything up to the next `^## ` (or the end of
 * the section stream, since the fence was already excluded by the caller)
 * is that section's body, trimmed. Only the exact `^## ` marker is special —
 * `###` and deeper headings inside a body are ordinary prose.
 */
const parseSections = (lines: ReadonlyArray<Line>): SectionsResult => {
	const errors: Array<DocumentParseError> = [];
	const sections: Array<Section> = [];

	let current:
		| { title: string; bodyLines: Array<string>; titleLine: number }
		| undefined;
	let reportedPreamble = false;

	const finalizeCurrent = () => {
		if (current === undefined) return;
		if (current.title.length === 0) {
			errors.push({
				line: current.titleLine,
				message: "Section heading has no title.",
			});
			return;
		}
		sections.push({
			title: current.title,
			body: current.bodyLines.join("\n").trim(),
		});
	};

	for (const line of lines) {
		const heading = SECTION_HEADING.exec(line.text);
		if (heading !== null) {
			finalizeCurrent();
			current = {
				title: (heading[1] as string).trim(),
				bodyLines: [],
				titleLine: line.number,
			};
			continue;
		}
		if (current === undefined) {
			if (line.text.trim().length > 0 && !reportedPreamble) {
				errors.push({
					line: line.number,
					message: "Content appears before the first section heading (`## `).",
				});
				reportedPreamble = true;
			}
			continue;
		}
		current.bodyLines.push(line.text);
	}
	finalizeCurrent();

	if (sections.length === 0 && errors.length === 0) {
		errors.push({
			line: lines.at(-1)?.number ?? 1,
			message:
				"The document has no sections — at least one `## ` heading is required.",
		});
	}

	return { sections, errors };
};

type ReferencesResult = {
	readonly references: ReadonlyArray<ReferenceBlock>;
	readonly errors: ReadonlyArray<DocumentParseError>;
};

/**
 * Inside the fence: `id: label` opens a block, `- path:start-end` adds a
 * location to it, blank lines are ignored, and anything else is an error.
 * `Location`'s schema requires `startLine`/`endLine >= 1` and
 * `ReferenceBlock`'s requires at least one location — both checked here,
 * with a line number, instead of falling through to a schema-decode error
 * with none.
 */
const parseReferenceBlocks = (
	fenceLines: ReadonlyArray<Line>,
): ReferencesResult => {
	const errors: Array<DocumentParseError> = [];
	const references: Array<ReferenceBlock> = [];

	let current:
		| {
				id: string;
				label: string;
				locations: Array<Location>;
				headerLine: number;
		  }
		| undefined;

	const finalizeCurrent = () => {
		if (current === undefined) return;
		if (current.locations.length === 0) {
			errors.push({
				line: current.headerLine,
				message: `Reference block "${current.id}" has no locations — every block needs at least one.`,
			});
			return;
		}
		references.push({
			id: current.id,
			label: current.label,
			locations: current.locations,
		});
	};

	for (const line of fenceLines) {
		if (line.text.trim().length === 0) continue;

		const header = REFERENCE_BLOCK_HEADER.exec(line.text);
		if (header !== null) {
			finalizeCurrent();
			current = {
				id: header[1] as string,
				label: header[2] as string,
				locations: [],
				headerLine: line.number,
			};
			continue;
		}

		const location = REFERENCE_LOCATION.exec(line.text);
		if (location !== null) {
			if (current === undefined) {
				errors.push({
					line: line.number,
					message: "Location line appears before any reference block header.",
				});
				continue;
			}
			const startLine = Number(location[2]);
			const endLine = Number(location[3]);
			if (startLine < 1 || endLine < 1) {
				errors.push({
					line: line.number,
					message: "Location line numbers must be 1 or greater.",
				});
				continue;
			}
			current.locations.push({
				path: location[1] as string,
				startLine,
				endLine,
			});
			continue;
		}

		errors.push({
			line: line.number,
			message: "Not a valid reference block header or location line.",
		});
	}
	finalizeCurrent();

	return { references, errors };
};

const decodeWalkthrough = Schema.decodeUnknownResult(Walkthrough);

/**
 * Parses the agent-facing markdown document into a `Walkthrough`. Errors are
 * collected across the whole document rather than thrown on the first one —
 * this text becomes the agent's retry feedback (`formatDocumentErrors`), and
 * a full list beats a single stop-the-world failure the same way the whole
 * feature exists to avoid a single opaque JSON parse offset.
 *
 * The grammar itself is built to already satisfy every `Walkthrough` schema
 * constraint (non-empty title/id/label, `startLine`/`endLine >= 1`, at least
 * one location per block, at least one section) — the final
 * `Schema.decodeUnknownResult` is a safety net against the two drifting
 * apart, not the primary source of feedback, so it only ever fires for a
 * constraint this parser doesn't yet know to check itself.
 */
export const parseDocument = (text: string): DocumentParseResult => {
	const lines = toLines(text);

	const fence = locateFence(lines);
	const sectionLines = lines.filter(
		(line) => !fence.excludedLineNumbers.has(line.number),
	);
	const sectionsResult = parseSections(sectionLines);
	const referencesResult =
		fence.fenceLines === undefined
			? { references: [], errors: [] }
			: parseReferenceBlocks(fence.fenceLines);

	const errors = [
		...fence.errors,
		...sectionsResult.errors,
		...referencesResult.errors,
	].sort((a, b) => a.line - b.line);

	if (errors.length > 0) {
		return { ok: false, errors };
	}

	const candidate = {
		version: 1 as const,
		sections: sectionsResult.sections,
		references: referencesResult.references,
	};
	const decoded = decodeWalkthrough(candidate);
	if (Result.isFailure(decoded)) {
		return {
			ok: false,
			errors: [{ line: 1, message: decoded.failure.message }],
		};
	}
	return { ok: true, walkthrough: decoded.success };
};

/** Feedback text for the agent's next turn — one bullet per error, each naming the line it's on. */
export const formatDocumentErrors = (
	errors: ReadonlyArray<DocumentParseError>,
): string =>
	[
		"The walkthrough document has parse errors that must be fixed before it can be accepted:",
		"",
		...errors.map((error) => `- Line ${error.line}: ${error.message}`),
		"",
		"Edit the buffer to fix these, then continue.",
	].join("\n");

/**
 * The inverse of `parseDocument` — not used by the agent loop itself (the
 * agent only ever reads back its own buffer text verbatim, via
 * `read_walkthrough`), but needed anywhere a decoded `Walkthrough` has to be
 * re-shown to the agent in the format it's told to write, and by the
 * round-trip tests that are this module's real spec.
 *
 * Assumes `walkthrough` already satisfies its own schema — in particular
 * that no `id` contains a colon or whitespace (`parseDocument` never
 * produces one that does, since its grammar can't represent it either) — so
 * it doesn't re-validate on the way out.
 */
export const serializeDocument = (walkthrough: Walkthrough): string => {
	const sectionsText = walkthrough.sections
		.map((section) => `## ${section.title}\n\n${section.body}`)
		.join("\n\n");

	const referencesText = walkthrough.references
		.map((block) => {
			const locationsText = block.locations
				.map(
					(location) =>
						`- ${location.path}:${location.startLine}-${location.endLine}`,
				)
				.join("\n");
			return `${block.id}: ${block.label}\n${locationsText}`;
		})
		.join("\n\n");

	return `${sectionsText}\n\n\`\`\`references\n${referencesText}\n\`\`\`\n`;
};
