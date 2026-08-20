import {
	type CoverageGap,
	changedLineRanges,
	validateCoverage,
} from "./coverage.ts";
import { formatDocumentErrors, parseDocument } from "./document.ts";
import { formatReferenceFeedback, validateReferences } from "./references.ts";
import type { Walkthrough } from "./schema.ts";

export type ChangedFileFacts = {
	readonly path: string;
	/** This file's patch against the merge-base (`@repo/git`'s `FileContent.patch`) — the changed-line set that must be covered. */
	readonly patch: string;
	/**
	 * Total line count of the file's head content — the ceiling a `Location`
	 * must fall within. Omit files with no head content (deletions); a
	 * `Location` pointing at one is then correctly reported as
	 * `unknown-file` rather than `out-of-range`.
	 */
	readonly lineCount: number;
};

type DecodeResult =
	| { readonly ok: true; readonly walkthrough: Walkthrough }
	| { readonly ok: false; readonly message: string };

/**
 * Decodes the raw buffer text the `write`/`edit` tools produced. Failures
 * (a malformed document, one that doesn't satisfy the walkthrough schema) are
 * returned as data, never thrown — `evaluateWalkthrough` turns them into
 * feedback text for the agent's next turn instead of crashing the caller.
 */
/**
 * An untouched buffer means the agent never called `write` at all — a
 * different failure from writing malformed JSON, and the far more common one
 * (a harness whose tool schema didn't reach the model, an agent that replied
 * in prose instead). Reporting it as "the buffer isn't valid JSON: Unexpected
 * EOF" describes a parse of nothing and gives the next turn no idea what to
 * do, so it retries identically until the turn budget runs out. Name the
 * actual missing step instead.
 */
const NOTHING_WRITTEN_FEEDBACK =
	"You haven't written the walkthrough yet — the output buffer is still empty. Call the `write` tool with the complete walkthrough as a single JSON document matching the schema in your instructions. Everything you produce must go through `write` (or `edit`); text in your reply is not collected.";

export const decodeBuffer = (bufferContent: string): DecodeResult => {
	if (bufferContent.trim().length === 0) {
		return { ok: false, message: NOTHING_WRITTEN_FEEDBACK };
	}

	const parsed = parseDocument(bufferContent);
	if (!parsed.ok) {
		return { ok: false, message: formatDocumentErrors(parsed.errors) };
	}
	return { ok: true, walkthrough: parsed.walkthrough };
};

export type WalkthroughEvaluation =
	| {
			readonly status: "valid";
			readonly walkthrough: Walkthrough;
			/**
			 * Changed lines no reference block claims — informational, not a
			 * reason this is `"valid"` rather than `"invalid"` (see this
			 * function's doc). Empty when the walkthrough happens to cover
			 * everything.
			 */
			readonly coverageGaps: ReadonlyArray<CoverageGap>;
	  }
	| { readonly status: "invalid"; readonly feedback: string };

/**
 * The full per-turn feedback loop: decode, then check reference integrity —
 * in that order, since a hallucinated path or an out-of-range line makes the
 * document itself broken, and either failure short-circuits with feedback
 * text describing exactly what to fix. Coverage is checked too, but no
 * longer gates validity: an agent that deliberately skipped narrating noise
 * (see `prompt.ts`) produced a valid walkthrough, not an incomplete one — its
 * gaps ride along as `coverageGaps` on the `valid` result for the caller to
 * persist and surface, rather than feeding back into another turn.
 */
export const evaluateWalkthrough = (
	bufferContent: string,
	changedFiles: ReadonlyArray<ChangedFileFacts>,
): WalkthroughEvaluation => {
	const decoded = decodeBuffer(bufferContent);
	if (!decoded.ok) {
		return { status: "invalid", feedback: decoded.message };
	}

	const lineCounts = new Map(
		changedFiles.map((file) => [file.path, file.lineCount] as const),
	);
	const referenceIssues = validateReferences(decoded.walkthrough, lineCounts);
	if (referenceIssues.length > 0) {
		return {
			status: "invalid",
			feedback: formatReferenceFeedback(referenceIssues),
		};
	}

	const changedRangesByPath = new Map(
		changedFiles.map(
			(file) => [file.path, changedLineRanges(file.patch)] as const,
		),
	);
	const coverage = validateCoverage(
		changedRangesByPath,
		decoded.walkthrough.references,
	);

	return {
		status: "valid",
		walkthrough: decoded.walkthrough,
		coverageGaps: coverage.ok ? [] : coverage.gaps,
	};
};
