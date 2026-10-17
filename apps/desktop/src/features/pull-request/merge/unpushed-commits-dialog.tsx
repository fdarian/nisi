"use client";

import { cn } from "cn";
import {
	ArrowDown,
	ArrowUp,
	CircleAlert,
	CircleCheck,
	CircleHelp,
	CloudCheck,
	CloudOff,
	type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { Spinner } from "#/components/ui/spinner";
import { Tabs, TabsList, TabsPanel, TabsTab } from "#/components/ui/tabs";
import type {
	BranchCommit,
	PushState,
	UnpushedCommitsCheck,
} from "#/features/pull-request/data/pr-data";
import { relativeTime } from "#/features/settings/repositories/repositories-view";

type UnpushedCheck = Exclude<UnpushedCommitsCheck, { status: "clean" }>;
type UnpushedBranchCheck = Extract<UnpushedCheck, { status: "unpushed" }>;

type UnpushedCommitsDialogProps = {
	check: UnpushedCheck | null;
	onOpenChange: (open: boolean) => void;
	onMergeAnyway: () => void;
	/** Defaults to idle. Ignored unless `onPush` is given. */
	push?: PushState;
	/** Renders the "Suggested" push action; the caller owns running git (with `rebase` set when the rebase suggestion was clicked) and feeding `push` back. */
	onPush?: (rebase: boolean) => void;
};

const MAX_VISIBLE_COMMITS = 5;
const SHORT_SHA_LENGTH = 7;

function commitCount(count: number): string {
	return `${count} ${count === 1 ? "commit" : "commits"}`;
}

function RefPill(props: {
	children: string;
	className?: string;
	title?: string;
}) {
	return (
		<code
			className={cn(
				"rounded-md border bg-muted px-1.5 py-0.5 font-mono text-foreground text-xs [overflow-wrap:anywhere]",
				props.className,
			)}
			title={props.title}
		>
			{props.children}
		</code>
	);
}

/** `ahead` is always >= 1 in the `"unpushed"` branch — `useUnpushedCommitsCheck` only ever produces that status for a nonzero count, `"clean"` covers zero. */
function UnpushedDescription(props: { check: UnpushedCheck; pushed: boolean }) {
	if (props.check.status === "unverifiable") {
		return `Nisi couldn't verify whether every local commit on this branch has been pushed: ${props.check.message}`;
	}
	if (props.pushed) {
		return (
			<>
				<RefPill>{props.check.remoteRef}</RefPill> now includes{" "}
				{props.check.ahead === 1 ? "it" : "them"}, so the merge will too.
			</>
		);
	}
	if (props.check.rewritten) {
		return (
			<>
				<RefPill>{props.check.remoteRef}</RefPill> was rewritten (rebased on
				GitHub?) and {commitCount(props.check.ahead)} on your local branch{" "}
				{props.check.ahead === 1 ? "has" : "have"} changes not found there, so{" "}
				{props.check.ahead === 1 ? "it" : "they"} won't be merged.
			</>
		);
	}
	return (
		<>
			Your local branch is {commitCount(props.check.ahead)} ahead of{" "}
			<RefPill>{props.check.remoteRef}</RefPill>. The merge uses what's on
			GitHub, so {props.check.ahead === 1 ? "this stays" : "these stay"} behind.
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

function RowRefPill(props: { children: string }) {
	return (
		<RefPill className="max-w-40 shrink truncate" title={props.children}>
			{props.children}
		</RefPill>
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
				{props.tag !== undefined ? (
					<RowRefPill>{props.tag}</RowRefPill>
				) : (
					<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
						{relativeTime(authoredAt, props.now)}
					</span>
				)}
			</div>
		</li>
	);
}

function TailRow(props: { dot: React.ReactNode; children: React.ReactNode }) {
	return (
		<li className="flex items-stretch gap-3">
			<Rail continuesDown={false} continuesUp dot={props.dot} />
			<div className="flex min-w-0 flex-1 items-baseline gap-2 py-1.5 text-sm">
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
			{props.head !== undefined ? (
				<>
					<ShortSha sha={props.head.sha} />
					<span className="min-w-0 flex-1 truncate" title={props.head.subject}>
						{props.head.subject}
					</span>
					<RowRefPill>{props.remoteRef}</RowRefPill>
				</>
			) : (
				<RowRefPill>{props.remoteRef}</RowRefPill>
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
	icon: LucideIcon;
	children: number;
}) {
	return (
		<span
			className={cn(
				"inline-flex items-center gap-0.5 rounded-full px-1.5 py-px font-medium text-xs tabular-nums",
				props.tone === "warning"
					? "bg-warning/12 text-warning-foreground"
					: "bg-success/12 text-success-foreground",
			)}
		>
			<props.icon aria-hidden className="size-3" />
			{props.children}
		</span>
	);
}

/** Both panels stay mounted in one grid cell so the box is as tall as the taller list — switching tabs never resizes the dialog. */
const STACKED_PANEL_CLASS_NAME =
	"col-start-1 row-start-1 [&[hidden]]:invisible [&[hidden]]:block";

function CommitGraph(props: { check: UnpushedBranchCheck; pushed: boolean }) {
	const localDot: DotKind = props.pushed ? "origin" : "unpushed";
	const localTone = props.pushed ? "success" : "warning";
	const now = Date.now();
	const origin = props.check.origin;

	if (origin === null || origin.commits.length === 0) {
		return (
			<div className="overflow-hidden rounded-lg border">
				<CommitList
					commits={props.check.commits}
					dot={localDot}
					now={now}
					tail={
						<RemoteHeadTail
							head={undefined}
							remoteRef={props.check.remoteRef}
						/>
					}
					totalCount={props.check.ahead}
				/>
			</div>
		);
	}

	return (
		<Tabs
			className="gap-0 overflow-hidden rounded-lg border"
			defaultValue="unpushed"
		>
			<div className="border-b bg-muted/48 px-2 py-1.5">
				<TabsList size="sm">
					<TabsTab value="unpushed">
						{props.pushed ? "Pushed" : "Not pushed"}
						<CountBadge icon={ArrowUp} tone={localTone}>
							{props.check.ahead}
						</CountBadge>
					</TabsTab>
					<TabsTab value="origin">
						On origin
						<CountBadge icon={ArrowDown} tone="success">
							{origin.count}
						</CountBadge>
					</TabsTab>
				</TabsList>
			</div>
			<div className="grid grid-cols-[minmax(0,1fr)]">
				<TabsPanel
					className={STACKED_PANEL_CLASS_NAME}
					keepMounted
					value="unpushed"
				>
					<CommitList
						commits={props.check.commits}
						dot={localDot}
						now={now}
						tail={
							<RemoteHeadTail
								head={origin.commits[0]}
								remoteRef={props.check.remoteRef}
							/>
						}
						totalCount={props.check.ahead}
					/>
				</TabsPanel>
				<TabsPanel
					className={STACKED_PANEL_CLASS_NAME}
					keepMounted
					value="origin"
				>
					<CommitList
						commits={origin.commits}
						dot="origin"
						now={now}
						tail={<BaseTail baseRef={origin.baseRef} />}
						topTag={props.check.remoteRef}
						totalCount={origin.count}
					/>
				</TabsPanel>
			</div>
		</Tabs>
	);
}

function PushLog(props: { lines: ReadonlyArray<string>; follow: boolean }) {
	const ref = useRef<HTMLPreElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll whenever a line arrives; the lines themselves aren't read here
	useEffect(() => {
		const element = ref.current;
		if (element === null) return;
		element.scrollTop = props.follow ? element.scrollHeight : 0;
	}, [props.lines.length, props.follow]);
	return (
		<pre
			className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-2 font-mono text-muted-foreground text-xs select-text"
			ref={ref}
		>
			{props.lines.join("\n")}
		</pre>
	);
}

/** Behind-only needs a rebase before a push can succeed; a rejected push (or a conflicted rebase) proves the remote moved even if the check that opened the dialog predates it. */
function suggestsRebase(check: UnpushedBranchCheck, push: PushState): boolean {
	return (
		check.behind > 0 ||
		(push.status === "failed" &&
			(push.reason === "rejected" || push.reason === "rebase-conflict"))
	);
}

function pushLabel(
	check: UnpushedBranchCheck,
	push: PushState,
	rebase: boolean,
): string {
	if (push.status === "running") return "Pushing…";
	const base = rebase
		? "Pull --rebase & push"
		: `Push ${commitCount(check.ahead)}`;
	if (push.status === "failed" && push.reason === "other") {
		return rebase ? "Retry pull --rebase & push" : "Retry push";
	}
	return base;
}

function PushButton(props: {
	push: PushState;
	check: UnpushedBranchCheck;
	onPush: (rebase: boolean) => void;
}) {
	const running = props.push.status === "running";
	const rebase = suggestsRebase(props.check, props.push);
	return (
		<button
			className="-mx-2 -my-1 flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-left text-sm outline-none transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64"
			disabled={running}
			onClick={() => props.onPush(rebase)}
			type="button"
		>
			{running ? (
				<Spinner className="size-4 shrink-0 text-muted-foreground" />
			) : (
				<ArrowUp className="size-4 shrink-0 text-muted-foreground" />
			)}
			<span className="min-w-0 flex-1 truncate">
				{pushLabel(props.check, props.push, rebase)}
			</span>
			<code className="shrink-0 font-mono text-muted-foreground text-xs">
				{rebase ? "git pull --rebase && git push" : "git push"}
			</code>
		</button>
	);
}

function PushedRow(props: {
	check: UnpushedBranchCheck;
	logOpen: boolean;
	onToggleLog: () => void;
}) {
	return (
		<div className="flex items-center gap-3 text-sm">
			<CircleCheck className="size-4 shrink-0 text-success-foreground" />
			<div className="flex min-w-0 flex-1 items-center gap-2">
				<span className="shrink-0">Pushed to</span>
				<RefPill className="min-w-0 truncate" title={props.check.remoteRef}>
					{props.check.remoteRef}
				</RefPill>
			</div>
			<Button onClick={props.onToggleLog} size="xs" variant="ghost">
				{props.logOpen ? "Hide log" : "Show log"}
			</Button>
		</div>
	);
}

function SuggestedPush(props: {
	push: PushState;
	check: UnpushedBranchCheck;
	onPush: (rebase: boolean) => void;
}) {
	const [logToggled, setLogToggled] = useState(false);
	const push = props.push;
	const logLines = push.status === "idle" ? [] : push.log;
	const logOpen =
		push.status === "succeeded"
			? logToggled
			: push.status !== "idle" && logLines.length > 0;
	return (
		<div className="flex flex-col gap-2">
			<span className="font-medium text-[0.6875rem] text-muted-foreground uppercase tracking-wider">
				Suggested
			</span>
			<div
				className={cn(
					"flex flex-col gap-2 rounded-lg border px-3 py-2",
					push.status === "failed" && "border-destructive/32 bg-destructive/4",
				)}
			>
				{push.status === "succeeded" ? (
					<PushedRow
						check={props.check}
						logOpen={logOpen}
						onToggleLog={() => setLogToggled((open) => !open)}
					/>
				) : (
					<PushButton check={props.check} onPush={props.onPush} push={push} />
				)}
				{push.status === "failed" && (
					<p className="flex items-start gap-1.5 text-destructive-foreground text-xs">
						<CircleAlert className="mt-px size-3.5 shrink-0" />
						{push.error}
					</p>
				)}
				{logOpen && (
					<PushLog follow={push.status === "running"} lines={logLines} />
				)}
			</div>
		</div>
	);
}

/**
 * The pre-merge confirmation `PrMergeButton` opens when a fresh
 * `unpushedCommits` check (fired at click time, see `useUnpushedCommitsCheck`
 * — never a cached count) finds either real unpushed commits or can't tell
 * either way. Both cases render the same shape — only the copy differs — so
 * one component covers both rather than two near-identical dialogs. The
 * commit graph is tabbed into "Not pushed" / "On origin" when the check
 * carries commits already on the remote branch beyond the base.
 * `check === null` renders nothing rather than an empty dialog shell, so the
 * caller can keep this mounted unconditionally and just flip `check`.
 */
export function UnpushedCommitsDialog({
	check,
	onOpenChange,
	onMergeAnyway,
	push,
	onPush,
}: UnpushedCommitsDialogProps): React.ReactElement {
	const isUnverifiable = check?.status === "unverifiable";
	const pushState: PushState = push ?? { status: "idle" };
	const showPush = check?.status === "unpushed" && onPush !== undefined;
	const isPushed = showPush && pushState.status === "succeeded";
	const isPushing = showPush && pushState.status === "running";
	return (
		<AlertDialog
			onOpenChange={(open) => {
				// Escape and outside clicks arrive here as well as the buttons —
				// dismissing mid-push would orphan a git process the user can't see.
				if (isPushing) return;
				onOpenChange(open);
			}}
			open={check !== null}
		>
			<AlertDialogContent className="max-h-[calc(100dvh-2rem)] max-w-xl max-sm:max-h-[calc(100dvh-3rem)]">
				<AlertDialogHeader className="shrink-0 flex-row items-start gap-4 text-left">
					<span
						className={cn(
							"flex size-10 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
							isUnverifiable && "bg-muted text-muted-foreground",
							isPushed && "bg-success/12 text-success-foreground",
							!(isUnverifiable || isPushed) &&
								"bg-warning/12 text-warning-foreground",
						)}
					>
						{isUnverifiable ? (
							<CircleHelp />
						) : isPushed ? (
							<CloudCheck />
						) : (
							<CloudOff />
						)}
					</span>
					<div className="flex min-w-0 flex-col gap-2">
						<AlertDialogTitle>
							{check === null || check.status === "unverifiable"
								? "Can't verify pushed commits"
								: check.rewritten && !isPushed
									? "Remote branch was rewritten"
									: `${commitCount(check.ahead)} ${isPushed ? "pushed" : "won't be merged"}`}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{check !== null && (
								<UnpushedDescription check={check} pushed={isPushed} />
							)}
						</AlertDialogDescription>
					</div>
				</AlertDialogHeader>
				{check?.status === "unpushed" && (
					<div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-6 pb-6 *:shrink-0">
						<CommitGraph check={check} pushed={isPushed} />
						{onPush !== undefined && (
							<SuggestedPush check={check} onPush={onPush} push={pushState} />
						)}
					</div>
				)}
				<AlertDialogFooter className="shrink-0">
					<AlertDialogClose
						disabled={isPushing}
						render={<Button disabled={isPushing} variant="outline" />}
					>
						Cancel
					</AlertDialogClose>
					{pushState.status === "succeeded" && showPush ? (
						<AlertDialogClose render={<Button onClick={onMergeAnyway} />}>
							Merge
						</AlertDialogClose>
					) : (
						<AlertDialogClose
							disabled={isPushing}
							render={
								<Button
									disabled={isPushing}
									onClick={onMergeAnyway}
									variant="warning-secondary"
								/>
							}
						>
							Merge anyway
						</AlertDialogClose>
					)}
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}
