"use client";

import {
	AlertDialog,
	AlertDialogClose,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import { Button } from "#/components/ui/button";
import type { UnpushedCommitsCheck } from "#/lib/pr-data";

type UnpushedCheck = Exclude<UnpushedCommitsCheck, { status: "clean" }>;

type UnpushedCommitsDialogProps = {
	check: UnpushedCheck | null;
	onOpenChange: (open: boolean) => void;
	onMergeAnyway: () => void;
};

/** `count` is always >= 1 in the `"unpushed"` branch — `useUnpushedCommitsCheck` only ever produces that status for a nonzero count, `"clean"` covers zero. */
function unpushedCommitsDescription(check: UnpushedCheck): string {
	if (check.status === "unverifiable") {
		return `Nisi couldn't verify whether every local commit on this branch has been pushed: ${check.message}`;
	}
	const commitWord = check.count === 1 ? "commit" : "commits";
	const isAre = check.count === 1 ? "isn't" : "aren't";
	return `${check.count} local ${commitWord} on this branch ${isAre} on ${check.remoteRef} and won't be included in this merge.`;
}

/**
 * The pre-merge confirmation `PrMergeButton` opens when a fresh
 * `unpushedCommits` check (fired at click time, see `useUnpushedCommitsCheck`
 * — never a cached count) finds either real unpushed commits or can't tell
 * either way. Both cases render the same shape — only the copy differs — so
 * one component covers both rather than two near-identical dialogs.
 * `check === null` renders nothing rather than an empty dialog shell, so the
 * caller can keep this mounted unconditionally and just flip `check`.
 */
export function UnpushedCommitsDialog({
	check,
	onOpenChange,
	onMergeAnyway,
}: UnpushedCommitsDialogProps): React.ReactElement {
	return (
		<AlertDialog onOpenChange={onOpenChange} open={check !== null}>
			<AlertDialogContent>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{check?.status === "unverifiable"
							? "Can't verify pushed commits"
							: "Unpushed commits won't be merged"}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{check === null ? "" : unpushedCommitsDescription(check)}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<AlertDialogFooter>
					<AlertDialogClose render={<Button variant="outline" />}>
						Cancel
					</AlertDialogClose>
					<AlertDialogClose render={<Button onClick={onMergeAnyway} />}>
						Merge anyway
					</AlertDialogClose>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
