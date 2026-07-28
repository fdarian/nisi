import { Result, Schema } from "effect";
import {
	changedLineRanges,
	formatCoverageFeedback,
	validateCoverage,
} from "./coverage.ts";
import { formatReferenceFeedback, validateReferences } from "./references.ts";
import { Walkthrough } from "./schema.ts";

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

const parseJson = (
	text: string,
):
	| { readonly ok: true; readonly value: unknown }
	| { readonly ok: false; readonly message: string } => {
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch (cause) {
		return {
			ok: false,
			message: cause instanceof Error ? cause.message : String(cause),
		};
	}
};

const decodeWalkthrough = Schema.decodeUnknownResult(Walkthrough);

/**
 * Decodes the raw buffer text the `write`/`edit` tools produced. Failures
 * (invalid JSON or a schema mismatch) are returned as data, never thrown —
 * `evaluateWalkthrough` turns them into feedback text for the agent's next
 * turn instead of crashing the caller.
 */
export const decodeBuffer = (bufferContent: string): DecodeResult => {
	const parsed = parseJson(bufferContent);
	if (!parsed.ok) {
		return {
			ok: false,
			message: `The buffer isn't valid JSON: ${parsed.message}`,
		};
	}
	return Result.match(decodeWalkthrough(parsed.value), {
		onSuccess: (walkthrough): DecodeResult => ({ ok: true, walkthrough }),
		onFailure: (error): DecodeResult => ({ ok: false, message: error.message }),
	});
};

export type WalkthroughEvaluation =
	| { readonly status: "valid"; readonly walkthrough: Walkthrough }
	| { readonly status: "invalid"; readonly feedback: string };

/**
 * The full per-turn feedback loop: decode, then check reference integrity,
 * then check coverage — in that order, since coverage's numbers are only
 * meaningful once every location is known to point somewhere real. Any
 * failure short-circuits with feedback text describing exactly what to fix;
 * only a walkthrough clearing all three is `valid`.
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
	if (!coverage.ok) {
		return {
			status: "invalid",
			feedback: formatCoverageFeedback(coverage.gaps),
		};
	}

	return { status: "valid", walkthrough: decoded.walkthrough };
};
