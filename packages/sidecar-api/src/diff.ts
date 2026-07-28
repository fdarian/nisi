import { oc } from "@orpc/contract";
import { Schema } from "effect";

export const FileStatus = Schema.Literals([
	"added",
	"modified",
	"deleted",
	"renamed",
]);
export type FileStatus = Schema.Schema.Type<typeof FileStatus>;

export const FileCategory = Schema.Literals([
	"implementation",
	"test",
	"generated",
]);
export type FileCategory = Schema.Schema.Type<typeof FileCategory>;

/**
 * Per-file review state — `null` when the file has never been ticked
 * Reviewed. Rides on `FileChange` rather than its own `review.list`
 * procedure: every consumer (sidebar mute + orange dot, diff pane checkbox +
 * collapsing) is already rendering a file row, so one round trip serves all
 * of them with no client-side join. See PLAN.md, Phase 1's contract note.
 */
export const FileReview = Schema.Struct({
	viewed: Schema.Boolean,
	reviewedHash: Schema.NullOr(Schema.String),
	/**
	 * Cheap (a content hash compare, not a diff) — `true` whenever the
	 * worktree has moved since the snapshot was taken, regardless of *where*.
	 * The detailed line-range breakdown of what's actually new is
	 * `diff.file`'s `review.ranges`, fetched lazily like the rest of a file's
	 * content.
	 */
	changedSinceReview: Schema.Boolean,
});
export type FileReview = Schema.Schema.Type<typeof FileReview>;

export const FileChange = Schema.Struct({
	path: Schema.String,
	oldPath: Schema.optional(Schema.String),
	status: FileStatus,
	category: FileCategory,
	additions: Schema.Number,
	deletions: Schema.Number,
	fingerprint: Schema.String,
	binary: Schema.Boolean,
	review: Schema.NullOr(FileReview),
});
export type FileChange = Schema.Schema.Type<typeof FileChange>;

/**
 * One contiguous run of the `base → head` diff, tagged by whether it's still
 * exactly what was reviewed (`reviewed` — the diff pane collapses it behind
 * a marker) or has moved since (`new` — it surfaces). 1-based inclusive,
 * in **head** (current file content) line numbers — the same numbering the
 * `base → head` diff itself renders under, so these can be handed straight
 * to the diff renderer's per-line annotation hook with no re-derivation.
 */
export const ReviewRange = Schema.Struct({
	startLine: Schema.Number,
	endLine: Schema.Number,
	status: Schema.Literals(["reviewed", "new"]),
});
export type ReviewRange = Schema.Schema.Type<typeof ReviewRange>;

/**
 * The reconciliation payload for one file — present only when the file has
 * been ticked Reviewed. `ranges` covers every line the `base → head` diff
 * touches; when absent (e.g. content past the size gate, so there's nothing
 * to reconcile against) it's an empty array, not a missing field, so the
 * frontend never needs to branch on "was this even computed."
 */
export const FileContentReview = Schema.Struct({
	changedSinceReview: Schema.Boolean,
	ranges: Schema.Array(ReviewRange),
});
export type FileContentReview = Schema.Schema.Type<typeof FileContentReview>;

export const FileContent = Schema.Struct({
	patch: Schema.String,
	oldContent: Schema.optional(Schema.String),
	newContent: Schema.optional(Schema.String),
	truncated: Schema.Boolean,
	review: Schema.NullOr(FileContentReview),
});
export type FileContent = Schema.Schema.Type<typeof FileContent>;

export const diffContract = {
	/** Metadata only, every changed file — the sidebar's data source. */
	files: oc
		.input(Schema.Struct({ sessionId: Schema.String }))
		.output(Schema.Array(FileChange))
		.errors({ NOT_FOUND: {} }),
	/** One file's patch + contents, lazy — the diff pane's data source. */
	file: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				path: Schema.String,
				/**
				 * The file's pre-rename path, when it's a rename — the same
				 * `FileChange.oldPath` the sidebar already has. Without it, a
				 * rename's review state (keyed by the pre-rename path — see
				 * `@repo/review`'s `resolveReviewState`) can't be found from just
				 * the new path, and `review` would be reported `null` even though
				 * the file was reviewed under its old name.
				 */
				oldPath: Schema.optional(Schema.String),
				/**
				 * Overrides the load-on-demand size tier (up to 2MB) to actually load
				 * it. Addition beyond PLAN.md's contract sketch: without it, that tier
				 * could be reported but never fetched. The patch-only tier above 2MB
				 * is never overridable.
				 */
				force: Schema.optional(Schema.Boolean),
			}),
		)
		.output(FileContent)
		.errors({ NOT_FOUND: {} }),
};
