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
 * of them with no client-side join.
 */
export const FileReview = Schema.Struct({
	viewed: Schema.Boolean,
	reviewedHash: Schema.NullOr(Schema.String),
	/**
	 * Cheap (a content hash compare, not a diff) — `true` whenever the
	 * worktree has moved since the snapshot was taken, regardless of *where*.
	 * The detailed line-range breakdown of what's actually new is
	 * `diff.fileContents`' `review.ranges`, fetched lazily like the rest of a file's
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
 * What currently vouches for a reviewed range — mirrors `@repo/review`'s
 * `ReviewSource`. `{kind: "file"}` is the whole-file Reviewed checkbox;
 * `{kind: "range", blockId, blockLabel}` is a walkthrough reference block's
 * claim on this specific location, which Files Changed renders as a
 * "reviewed in `<blockLabel>`" marker linking back to the block.
 */
export const ReviewSource = Schema.Union([
	Schema.Struct({ kind: Schema.Literal("file") }),
	Schema.Struct({
		kind: Schema.Literal("range"),
		blockId: Schema.String,
		blockLabel: Schema.String,
	}),
]);
export type ReviewSource = Schema.Schema.Type<typeof ReviewSource>;

/**
 * One contiguous run of the `base → head` diff, tagged by whether it's still
 * exactly what some claim reviewed (`reviewed` — the diff pane collapses it
 * behind a marker) or has moved since (`new` — it surfaces). 1-based
 * inclusive, in **head** (current file content) line numbers — the same
 * numbering the `base → head` diff itself renders under, so these can be
 * handed straight to the diff renderer's per-line annotation hook with no
 * re-derivation.
 */
export const ReviewRange = Schema.Struct({
	startLine: Schema.Number,
	endLine: Schema.Number,
	status: Schema.Literals(["reviewed", "new"]),
	/** Which claim currently vouches for this range. `null` iff `status` is `"new"`. */
	reviewedVia: Schema.NullOr(ReviewSource),
});
export type ReviewRange = Schema.Schema.Type<typeof ReviewRange>;

/**
 * The reconciliation payload for one file — present whenever the file has
 * *any* active review claim, whole-file or block-scoped range (a file with
 * only range claims and no whole-file tick still gets one, so Files Changed
 * can render "reviewed in `<block>`" markers on it). `ranges` covers every
 * line the `base → head` diff touches; when absent (e.g. content past the
 * size gate, so there's nothing to reconcile against) it's an empty array,
 * not a missing field, so the frontend never needs to branch on "was this
 * even computed."
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

/**
 * Mirrors `@repo/settings`'s `includeUncommitted` — `false`/absent (the
 * default) restricts the diff to `merge-base..HEAD`; `true` widens it to the
 * worktree, staged/unstaged/untracked changes included too. See `@repo/git`'s
 * `getChangedFiles`/`getFileContents` for what the flag does underneath.
 */
const IncludeUncommitted = Schema.optional(Schema.Boolean);

/** One requested path within a `diff.fileContents` batch — see that procedure's doc comment. */
export const FileContentRequest = Schema.Struct({
	path: Schema.String,
	/**
	 * The file's pre-rename path, when it's a rename — the same
	 * `FileChange.oldPath` the sidebar already has. Without it, a rename's
	 * review state (keyed by the pre-rename path — see `@repo/review`'s
	 * `resolveReviewState`) can't be found from just the new path, and
	 * `review` would be reported `null` even though the file was reviewed
	 * under its old name.
	 */
	oldPath: Schema.optional(Schema.String),
	/**
	 * Overrides the load-on-demand size tier (up to 2MB) to actually load it
	 * — without it, that tier could be reported but never fetched. The
	 * patch-only tier above 2MB is never overridable. Per-path, since one
	 * batch commonly mixes a just-forced file with everything else.
	 */
	force: Schema.optional(Schema.Boolean),
});
export type FileContentRequest = Schema.Schema.Type<typeof FileContentRequest>;

/** One path's result within a `diff.fileContents` batch — `content` is `null` when the path turned out not to be part of the diff (mirrors the single-file procedure's old `NOT_FOUND`), rather than failing the whole batch over one stale path. */
export const FileContentResult = Schema.Struct({
	path: Schema.String,
	content: Schema.NullOr(FileContent),
});
export type FileContentResult = Schema.Schema.Type<typeof FileContentResult>;

export const diffContract = {
	/** Metadata only, every changed file — the sidebar's data source. */
	files: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				includeUncommitted: IncludeUncommitted,
			}),
		)
		.output(Schema.Array(FileChange))
		.errors({ NOT_FOUND: {} }),
	/**
	 * Every requested path's patch + contents, in one round trip — the diff
	 * pane's data source. Batched (not one-procedure-per-file) because
	 * opening N files otherwise costs N independent round trips, each paying
	 * its own merge-base/status/blob-read/patch-read subprocess spawns on the
	 * sidecar side for no benefit — `@repo/git`'s `getFileContents` resolves
	 * all of them once per call regardless of how many paths are requested.
	 */
	fileContents: oc
		.input(
			Schema.Struct({
				sessionId: Schema.String,
				paths: Schema.Array(FileContentRequest),
				includeUncommitted: IncludeUncommitted,
			}),
		)
		.output(Schema.Array(FileContentResult))
		.errors({ NOT_FOUND: {} }),
};
