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
import { Tabs, TabsList, TabsPanel, TabsTab } from "#/components/ui/tabs";
import type {
	BranchCommit,
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

type DotKind = "unpushed" | "origin";

function CommitDot(props: { kind: DotKind }) {
	return (
		<span
			className={cn(
				"relative size-2.5 rounded-full",
				props.kind === "unpushed"
					? "border-2 border-warning bg-popover"
					: "bg-success",
			)}
		/>
	);
}

function ShortSha(props: { sha: string }) {
	return (
		<code className="shrink-0 font-mono text-muted-foreground text-xs">
			{props.sha.slice(0, SHORT_SHA_LENGTH)}
		</code>
	);
}

function CommitRow(props: {
	commit: BranchCommit;
	dot: DotKind;
	continuesUp: boolean;
	continuesDown: boolean;
	tag?: string;
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
			<Rail
				continuesDown={props.continuesDown}
				continuesUp={props.continuesUp}
				dot={<CommitDot kind={props.dot} />}
			/>
			<div className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-sm">
				<ShortSha sha={props.commit.sha} />
				<span className="min-w-0 flex-1 truncate" title={props.commit.subject}>
					{props.commit.subject}
				</span>
				{props.tag !== undefined && (
					<RefPill className="max-w-40 shrink truncate">{props.tag}</RefPill>
				)}
				<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
					{relativeTime(authoredAt, props.now)}
				</span>
			</div>
		</li>
	);
}

function TailRow(props: { dot: React.ReactNode; children: React.ReactNode }) {
	return (
		<li className="flex items-stretch gap-3">
			<Rail continuesDown={false} continuesUp dot={props.dot} />
			<div className="flex min-w-0 flex-1 flex-col justify-center py-1.5 text-sm">
				{props.children}
			</div>
		</li>
	);
}

/** `totalCount` can exceed `commits.length` when the sidecar caps the list; the surplus is folded into the same "+N more" row. */
function CommitList(props: {
	commits: ReadonlyArray<BranchCommit>;
	totalCount: number;
	dot: DotKind;
	topTag?: string;
	tail: React.ReactElement | null;
	now: number;
}) {
	const visible = props.commits.slice(0, MAX_VISIBLE_COMMITS);
	const hiddenCount = props.totalCount - visible.length;
	const hasTail = props.tail !== null;
	return (
		<ol className="px-3 py-1">
			{visible.map((commit, index) => (
				<CommitRow
					commit={commit}
					continuesDown={
						hasTail || hiddenCount > 0 || index < visible.length - 1
					}
					continuesUp={index > 0}
					dot={props.dot}
					key={commit.sha}
					now={props.now}
					tag={index === 0 ? props.topTag : undefined}
				/>
			))}
			{hiddenCount > 0 && (
				<li className="flex items-stretch gap-3">
					<Rail
						continuesDown={hasTail}
						continuesUp
						dot={<span className="size-1 rounded-full bg-foreground/30" />}
					/>
					<span className="py-1.5 text-muted-foreground text-xs">
						+{hiddenCount} more
					</span>
				</li>
			)}
			{props.tail}
		</ol>
	);
}

function RemoteHeadTail(props: {
	remoteRef: string;
	head: BranchCommit | undefined;
}) {
	return (
		<TailRow
			dot={
				<span className="relative size-2.5 rounded-full bg-muted-foreground" />
			}
		>
			<div className="flex min-w-0 items-baseline gap-2">
				<RefPill className="min-w-0 shrink truncate">{props.remoteRef}</RefPill>
				{props.head !== undefined ? (
					<>
						<ShortSha sha={props.head.sha} />
						<span
							className="min-w-0 flex-1 truncate"
							title={props.head.subject}
						>
							{props.head.subject}
						</span>
					</>
				) : (
					<span className="shrink-0 text-muted-foreground text-xs">
						merge includes up to here
					</span>
				)}
			</div>
			{props.head !== undefined && (
				<span className="text-muted-foreground text-xs">
					merge includes up to here
				</span>
			)}
		</TailRow>
	);
}

function BaseTail(props: { baseRef: string }) {
	return (
		<TailRow
			dot={
				<span className="relative size-2.5 rounded-full border-2 border-foreground/30 bg-popover" />
			}
		>
			<span className="flex items-baseline gap-2 text-muted-foreground text-xs">
				<RefPill>{props.baseRef}</RefPill> base
			</span>
		</TailRow>
	);
}

function CountBadge(props: {
	tone: "warning" | "success";
	prefix?: string;
	children: number;
}) {
	return (
		<span
			className={cn(
				"rounded-full px-1.5 py-px font-medium text-xs tabular-nums",
				props.tone === "warning"
					? "bg-warning/12 text-warning-foreground"
					: "bg-success/12 text-success-foreground",
			)}
		>
			{props.prefix}
			{props.children}
		</span>
	);
}

function LocalBranchPill(props: { branch: string }) {
	return <RefPill className="min-w-0 truncate">{props.branch}</RefPill>;
}

/** Both panels stay mounted in one grid cell so the box is as tall as the taller list — switching tabs never resizes the dialog. */
const STACKED_PANEL_CLASS_NAME =
	"col-start-1 row-start-1 [&[hidden]]:invisible [&[hidden]]:block";

function CommitGraph(props: {
	check: UnpushedBranchCheck;
	commits: ReadonlyArray<BranchCommit>;
}) {
	const now = Date.now();
	const remoteCommits = props.check.remoteCommits;
	const isTabbed = remoteCommits !== undefined && remoteCommits.length > 0;
	const localBranch = props.check.localBranch;

	if (!isTabbed) {
		return (
			<div className="mx-6 mb-6 overflow-hidden rounded-lg border">
				{localBranch !== undefined && (
					<div className="flex items-center gap-2 border-b bg-muted/48 px-3 py-2">
						<LocalBranchPill branch={localBranch} />
						<span className="shrink-0">
							<CountBadge prefix="↑" tone="warning">
								{props.check.count}
							</CountBadge>
						</span>
					</div>
				)}
				<CommitList
					commits={props.commits}
					dot="unpushed"
					now={now}
					tail={
						<RemoteHeadTail
							head={undefined}
							remoteRef={props.check.remoteRef}
						/>
					}
					totalCount={props.check.count}
				/>
			</div>
		);
	}

	return (
		<Tabs
			className="mx-6 mb-6 gap-0 overflow-hidden rounded-lg border"
			defaultValue="unpushed"
		>
			<div className="flex items-center justify-between gap-3 border-b bg-muted/48 px-2 py-1.5">
				<TabsList size="sm">
					<TabsTab value="unpushed">
						Not pushed
						<CountBadge tone="warning">{props.check.count}</CountBadge>
					</TabsTab>
					<TabsTab value="origin">
						On origin
						<CountBadge tone="success">{remoteCommits.length}</CountBadge>
					</TabsTab>
				</TabsList>
				{localBranch !== undefined && <LocalBranchPill branch={localBranch} />}
			</div>
			<div className="grid">
				<TabsPanel
					className={STACKED_PANEL_CLASS_NAME}
					keepMounted
					value="unpushed"
				>
					<CommitList
						commits={props.commits}
						dot="unpushed"
						now={now}
						tail={
							<RemoteHeadTail
								head={remoteCommits[0]}
								remoteRef={props.check.remoteRef}
							/>
						}
						totalCount={props.check.count}
					/>
				</TabsPanel>
				<TabsPanel
					className={STACKED_PANEL_CLASS_NAME}
					keepMounted
					value="origin"
				>
					<CommitList
						commits={remoteCommits}
						dot="origin"
						now={now}
						tail={
							props.check.baseRef === undefined ? null : (
								<BaseTail baseRef={props.check.baseRef} />
							)
						}
						topTag={props.check.remoteRef}
						totalCount={remoteCommits.length}
					/>
				</TabsPanel>
			</div>
		</Tabs>
	);
}

/**
 * The pre-merge confirmation `PrMergeButton` opens when a fresh
 * `unpushedCommits` check (fired at click time, see `useUnpushedCommitsCheck`
 * — never a cached count) finds either real unpushed commits or can't tell
 * either way. Both cases render the same shape — only the copy differs — so
 * one component covers both rather than two near-identical dialogs. The
 * commit graph appears only when the check carries `commits` (tabbed into
 * "Not pushed" / "On origin" when `remoteCommits` is present too); without
 * `commits` the dialog falls back to the count-only description.
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
