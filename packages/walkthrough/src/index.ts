export type { EditFailure, EditOutcome, WalkthroughBuffer } from "./buffer.ts";
export { applyEdit, createBuffer, describeEditFailure } from "./buffer.ts";

export type { CoverageGap, CoverageResult, LineRange } from "./coverage.ts";
export {
	changedLineRanges,
	formatCoverageFeedback,
	validateCoverage,
} from "./coverage.ts";

export type { DigestBudget, DigestEntry, DigestFile } from "./digest.ts";
export { buildDigest, defaultDigestBudget, renderDigest } from "./digest.ts";

export { buildSystemPrompt } from "./prompt.ts";

export type { ReferenceIssue } from "./references.ts";
export {
	extractReferenceLinks,
	formatReferenceFeedback,
	validateReferences,
} from "./references.ts";

// `Location`/`ReferenceBlock`/`Section`/`Walkthrough` are each both a schema
// value and its inferred type (the usual Effect Schema pattern) — one
// re-export carries both.
export {
	Location,
	ReferenceBlock,
	Section,
	Walkthrough,
	walkthroughJsonSchema,
	walkthroughJsonSchemaDocument,
} from "./schema.ts";

export {
	createWalkthroughTools,
	WALKTHROUGH_TOOL_NAMES,
	type WalkthroughToolNames,
} from "./tools.ts";

export type { ChangedFileFacts, WalkthroughEvaluation } from "./validate.ts";
export { decodeBuffer, evaluateWalkthrough } from "./validate.ts";
