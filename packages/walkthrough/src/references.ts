import type { ReferenceBlock, Section, Walkthrough } from "./schema.ts";

export type ReferenceIssue =
	| { readonly type: "duplicate-id"; readonly id: string }
	| {
			readonly type: "dangling-link";
			readonly sectionTitle: string;
			readonly id: string;
	  }
	| {
			readonly type: "unknown-file";
			readonly refId: string;
			readonly path: string;
	  }
	| {
			readonly type: "invalid-range";
			readonly refId: string;
			readonly path: string;
			readonly startLine: number;
			readonly endLine: number;
	  }
	| {
			readonly type: "out-of-range";
			readonly refId: string;
			readonly path: string;
			readonly startLine: number;
			readonly endLine: number;
			readonly lineCount: number;
	  };

const REFERENCE_LINK_PATTERN = /\[[^\]]*\]\(ref:([^)]+)\)/g;

/** Every `ref:<id>` a section body links to via `[text](ref:<id>)`, in order of appearance. */
export const extractReferenceLinks = (body: string): ReadonlyArray<string> =>
	[...body.matchAll(REFERENCE_LINK_PATTERN)].flatMap((match) =>
		match[1] === undefined ? [] : [match[1]],
	);

const duplicateIdIssues = (
	references: ReadonlyArray<ReferenceBlock>,
): ReadonlyArray<ReferenceIssue> => {
	const seen = new Set<string>();
	return references.flatMap((block) => {
		if (seen.has(block.id))
			return [{ type: "duplicate-id", id: block.id } as const];
		seen.add(block.id);
		return [];
	});
};

/** A location must point at a real changed file, within that file's actual line count — caught here, not at render time. */
const locationIssues = (
	references: ReadonlyArray<ReferenceBlock>,
	lineCounts: ReadonlyMap<string, number>,
): ReadonlyArray<ReferenceIssue> =>
	references.flatMap((block) =>
		block.locations.flatMap((location): ReadonlyArray<ReferenceIssue> => {
			const lineCount = lineCounts.get(location.path);
			if (lineCount === undefined) {
				return [{ type: "unknown-file", refId: block.id, path: location.path }];
			}
			if (location.startLine > location.endLine) {
				return [
					{
						type: "invalid-range",
						refId: block.id,
						path: location.path,
						startLine: location.startLine,
						endLine: location.endLine,
					},
				];
			}
			if (location.endLine > lineCount) {
				return [
					{
						type: "out-of-range",
						refId: block.id,
						path: location.path,
						startLine: location.startLine,
						endLine: location.endLine,
						lineCount,
					},
				];
			}
			return [];
		}),
	);

const danglingLinkIssues = (
	sections: ReadonlyArray<Section>,
	knownIds: ReadonlySet<string>,
): ReadonlyArray<ReferenceIssue> =>
	sections.flatMap((section) =>
		extractReferenceLinks(section.body)
			.filter((id) => !knownIds.has(id))
			.map(
				(id) =>
					({ type: "dangling-link", sectionTitle: section.title, id }) as const,
			),
	);

/**
 * Reference integrity, independent of coverage: ids must be unique, every
 * `[text](ref:<id>)` link in a section body must resolve to a real block —
 * a dangling link is a broken UI — and every location must point at a real
 * changed file within its actual line count.
 */
export const validateReferences = (
	walkthrough: Walkthrough,
	lineCounts: ReadonlyMap<string, number>,
): ReadonlyArray<ReferenceIssue> => {
	const knownIds = new Set(walkthrough.references.map((block) => block.id));
	return [
		...duplicateIdIssues(walkthrough.references),
		...locationIssues(walkthrough.references, lineCounts),
		...danglingLinkIssues(walkthrough.sections, knownIds),
	];
};

const describeIssue = (issue: ReferenceIssue): string => {
	switch (issue.type) {
		case "duplicate-id":
			return `Reference id "${issue.id}" is used more than once — every reference block needs a unique id.`;
		case "dangling-link":
			return `Section "${issue.sectionTitle}" links to ref:${issue.id}, which doesn't match any reference block's id.`;
		case "unknown-file":
			return `Reference "${issue.refId}" points at "${issue.path}", which isn't a changed file in this PR.`;
		case "invalid-range":
			return `Reference "${issue.refId}" location in "${issue.path}" is invalid: startLine (${issue.startLine}) is after endLine (${issue.endLine}).`;
		case "out-of-range":
			return `Reference "${issue.refId}" location in "${issue.path}" (lines ${issue.startLine}-${issue.endLine}) is out of range — the file only has ${issue.lineCount} lines.`;
	}
};

export const formatReferenceFeedback = (
	issues: ReadonlyArray<ReferenceIssue>,
): string =>
	[
		"The walkthrough has reference problems that must be fixed before it can be accepted:",
		"",
		...issues.map((issue) => `- ${describeIssue(issue)}`),
		"",
		"Edit the buffer to fix these, then continue.",
	].join("\n");
