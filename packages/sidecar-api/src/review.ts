import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const reviewContract = {
	/**
	 * Writes the file's content snapshot immediately at tick time, regardless
	 * of whether anything reads it yet — so reconciliation can consume
	 * existing snapshots without ever needing a migration to backfill them.
	 */
	setViewed: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				viewed: Schema.Boolean,
			}),
		)
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
	/**
	 * Ticks (or unticks) one walkthrough reference block's claim on a set of
	 * line ranges within one file — Phase 3's range-scoped review, the
	 * write-side of `diff.file`'s `FileContentReview.ranges[].reviewedVia`.
	 * `ranges` is the block's full set of locations for this path (a block can
	 * claim several non-contiguous ranges in the same file — see
	 * `@repo/walkthrough`'s `ReferenceBlock.locations`), ticked or unticked as
	 * one unit, matching how the reference pane groups them into a single
	 * checkbox per block+path. `blockLabel`/`ranges` are ignored when
	 * `viewed` is `false` (unticking only needs `blockId` to find the claim),
	 * same asymmetry as `setViewed`'s `path` needing no content on unview.
	 */
	setRangeViewed: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				blockId: Schema.String,
				blockLabel: Schema.String,
				ranges: Schema.Array(
					Schema.Struct({ startLine: Schema.Number, endLine: Schema.Number }),
				).check(Schema.isMinLength(1)),
				viewed: Schema.Boolean,
			}),
		)
		.output(Schema.Void)
		.errors({ NOT_FOUND: {} }),
};
