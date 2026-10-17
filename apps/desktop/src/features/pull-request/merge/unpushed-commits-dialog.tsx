"use client";

import { cn } from "cn";
import { CircleHelp, CloudOff } from "lucide-react";
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
import type {
	UnpushedCommit,
	UnpushedCommitsCheck,
} from "#/features/pull-request/data/pr-data";
import { relativeTime } from "#/features/settings/repositories/repositories-view";

type UnpushedCheck = Exclude<UnpushedCommitsCheck, { status: "clean" }>;
type UnpushedBranchCheck = Extract<UnpushedCheck, { status: "unpushed" }>;

type UnpushedCommitsDialogProps = {
	check: UnpushedCheck | null;
	onOpenChange: (open: boolean) => void;
	onMergeAnyway: () => void;
};

const MAX_VISIBLE_COMMITS = 5;
const SHORT_SHA_LENGTH = 7;

function commitCount(count: number): string {
	return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function RefPill(props: { children: string; className?: string }) {
	return (
		<code
			className={cn(
				"rounded-md border bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs [overflow-wrap:anywhere]",
				props.className,
			)}
		>
			{props.children}
		</code>
	);
}

/** `count` is always >= 1 in the `"unpushed"` branch — `useUnpushedCommitsCheck` only ever produces that status for a nonzero count, `"clean"` covers zero. */
function UnpushedDescription(props: { check: UnpushedCheck }) {
	if (props.check.status === "unverifiable") {
		return `Nisi couldn't verify whether every local commit on this branch has been pushed: ${props.check.message}`;
	}
	return (
		<>
			Your local branch is {commitCount(props.check.count)} ahead of{" "}
			<RefPill>{props.check.remoteRef}</RefPill>. The merge uses what's on
			GitHub, so {props.check.count === 1 ? "this stays" : "these stay"} behind.
		</>
	);
}

function Rail(props: {
	dot: React.ReactNode;
	continuesUp: boolean;
	continuesDown: boolean;
}) {
	return (
		<span className="relative flex w-3 shrink-0 items-center justify-center self-stretch">
			<span
				className={cn(
					"absolute left-1/2 w-px -translate-x-1/2 bg-foreground/20",
					props.continuesUp ? "top-0" : "top-1/2",
					props.continuesDown ? "bottom-0" : "bottom-1/2",
				)}
			/>
			{props.dot}
		</span>
	);
}

function UnpushedDot() {
	return (
		<span className="relative size-2.5 rounded-full border-2 border-warning bg-popover" />
	);
}

function CommitRow(props: {
	commit: UnpushedCommit;
	isFirst: boolean;
	now: number;
}) {
	const authoredAt = Date.parse(props.commit.authoredAt);
	if (Number.isNaN(authoredAt)) {
		throw new Error(
			`Commit ${props.commit.sha} has an invalid authoredAt: ${props.commit.authoredAt}`,
		);
	}
	return (
		<li className="flex items-stretch gap-3">
			<Rail continuesDown continuesUp={!props.isFirst} dot={<UnpushedDot />} />
			<div className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-sm">
				<code className="shrink-0 font-mono text-muted-foreground text-xs">
					{props.commit.sha.slice(0, SHORT_SHA_LENGTH)}
				</code>
				<span className="min-w-0 flex-1 truncate" title={props.commit.subject}>
					{props.commit.subject}
				</span>
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{relativeTime(authoredAt, props.now)}
				</span>
			</div>
		</li>
	);
}

function CommitGraph(props: {
	check: UnpushedBranchCheck;
	commits: ReadonlyArray<UnpushedCommit>;
}) {
	const now = Date.now();
	const visible = props.commits.slice(0, MAX_VISIBLE_COMMITS);
	const hiddenCount = props.check.count - visible.length;
	return (
		<div className="mx-6 mb-6 overflow-hidden rounded-lg border">
			{props.check.localBranch !== undefined && (
				<div className="flex items-center gap-2 border-b bg-muted/48 px-3 py-2">
					<RefPill className="min-w-0 truncate">
						{props.check.localBranch}
					</RefPill>
					<span className="shrink-0 rounded-full bg-warning/12 px-1.5 py-0.5 font-medium text-warning-foreground text-xs tabular-nums">
						↑{props.check.count}
					</span>
				</div>
			)}
			<ol className="px-3 py-1">
				{visible.map((commit, index) => (
					<CommitRow
						commit={commit}
						isFirst={index === 0}
						key={commit.sha}
						now={now}
					/>
				))}
				{hiddenCount > 0 && (
					<li className="flex items-stretch gap-3">
						<Rail
							continuesDown
							continuesUp
							dot={<span className="size-1 rounded-full bg-foreground/30" />}
						/>
						<span className="py-1.5 text-muted-foreground text-xs">
							+{hiddenCount} more
						</span>
					</li>
				)}
				<li className="flex items-stretch gap-3">
					<Rail
						continuesDown={false}
						continuesUp
						dot={
							<span className="relative size-2.5 rounded-full bg-muted-foreground" />
						}
					/>
					<div className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-sm">
						<RefPill className="min-w-0 truncate">
							{props.check.remoteRef}
						</RefPill>
						<span className="shrink-0 text-muted-foreground text-xs">
							merge includes up to here
						</span>
					</div>
				</li>
			</ol>
		</div>
	);
}

/**
 * The pre-merge confirmation `PrMergeButton` opens when a fresh
 * `unpushedCommits` check (fired at click time, see `useUnpushedCommitsCheck`
 * — never a cached count) finds either real unpushed commits or can't tell
 * either way. Both cases render the same shape — only the copy differs — so
 * one component covers both rather than two near-identical dialogs. The
 * commit graph appears only when the check carries `commits`; without them
 * the dialog falls back to the count-only description.
 * `check === null` renders nothing rather than an empty dialog shell, so the
 * caller can keep this mounted unconditionally and just flip `check`.
 */
export function UnpushedCommitsDialog({
	check,
	onOpenChange,
	onMergeAnyway,
}: UnpushedCommitsDialogProps): React.ReactElement {
	const isUnverifiable = check?.status === "unverifiable";
	return (
		<AlertDialog onOpenChange={onOpenChange} open={check !== null}>
			<AlertDialogContent className="max-w-xl">
				<AlertDialogHeader className="flex-row items-start gap-4 text-left">
					<span
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
							isUnverifiable
								? "bg-muted text-muted-foreground"
								: "bg-warning/12 text-warning-foreground",
						)}
					>
						{isUnverifiable ? <CircleHelp /> : <CloudOff />}
					</span>
					<div className="flex min-w-0 flex-col gap-2">
						<AlertDialogTitle>
							{check === null || check.status === "unverifiable"
								? "Can't verify pushed commits"
								: `${commitCount(check.count)} won't be merged`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{check !== null && <UnpushedDescription check={check} />}
						</AlertDialogDescription>
					</div>
				</AlertDialogHeader>
				{check?.status === "unpushed" && check.commits !== undefined && (
					<CommitGraph check={check} commits={check.commits} />
				)}
				<AlertDialogFooter className="sm:items-center">
					{!isUnverifiable && (
						<p className="text-muted-foreground text-xs sm:mr-auto">
							Push first to include them: <RefPill>git push</RefPill>
						</p>
					)}
					<AlertDialogClose render={<Button variant="outline" />}>
						Cancel
					</AlertDialogClose>
					<AlertDialogClose
						render={
							<Button onClick={onMergeAnyway} variant="warning-secondary" />
						}
					>
						Merge anyway
					</AlertDialogClose>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
