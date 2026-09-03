import { oc } from "@orpc/contract";
import { Schema } from "effect";

/**
 * One whole file's content for a file-viewer tab
 * (`apps/desktop/src/components/pr/file-view.tsx`) — rendered through
 * `@pierre/diffs`' plain `CodeViewFileItem`, which infers syntax
 * highlighting from the filename it's given (already known client-side,
 * it's the tab's own path), so there's nothing beyond the raw text this
 * needs to carry.
 */
export const FileViewerContent = Schema.Struct({
	content: Schema.String,
});
export type FileViewerContent = Schema.Schema.Type<typeof FileViewerContent>;

/**
 * Whole-file reads for the viewer tabs — deliberately not
 * `diffContract.fileContents`: that procedure is diff-scoped and reports
 * `content: null` for any path outside the current diff (see `diff.ts`),
 * which is exactly the case this feature exists to serve (a walkthrough
 * reference into an out-of-diff file, or "View full file" from Files
 * Changed). One path per call, unlike `fileContents`' batch shape — a
 * viewer tab is opened one at a time by a direct user action, so there's no
 * batch of paths to amortize a round trip over.
 *
 * `FILE_NOT_FOUND` and `FILE_TOO_LARGE` are real, renderable outcomes here,
 * not edge cases folded into a generic failure: a walkthrough reference can
 * point at a path that's since been deleted, and nothing bounds how large
 * an arbitrary repo path can be. See `apps/desktop/sidecar/store.ts`'s
 * `readFileViewerContent` for exactly what triggers each.
 */
export const fileContract = {
	get: oc
		.input(Schema.Struct({ sessionId: Schema.String, path: Schema.String }))
		.output(FileViewerContent)
		.errors({
			NOT_FOUND: {},
			FILE_NOT_FOUND: {},
			FILE_TOO_LARGE: {},
			INTERNAL_SERVER_ERROR: {},
		}),
};
