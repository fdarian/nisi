"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import { cn } from "cn";
import { CirclePause, Pause } from "lucide-react";
import type React from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { useDismissOnInactive } from "#/features/pull-request/use-dismiss-on-inactive";

export type CiCheckStatus =
	| "passing"
	| "failing"
	| "awaiting_approval"
	| "running"
	| "pending"
	| "skipped";

export type CiCheck = {
	name: string;
	status: CiCheckStatus;
	/** Free-form line shown under the name — a duration, a conclusion, whatever the source has. */
	detail?: string;
	/** Link to the check run on GitHub — absent for a check the source never supplied one for. */
	detailsUrl?: string;
};

type CiStatusProps = {
	checks: readonly CiCheck[];
	className?: string;
	/** Presentational only — the sidecar doesn't call GitHub's approve-workflow-run API yet. Rendered only when supplied. */
	onApproveWorkflows?: () => void;
	/** Disables the action and swaps its label to "Approving…" while `onApproveWorkflows`'s caller is mid-request. */
	isApproving?: boolean;
};

type WatchedCiStatusProps = CiStatusProps & {
	watched: boolean;
};

const STATUS_LABEL: Record<CiCheckStatus, string> = {
	passing: "Passing",
	failing: "Failing",
	awaiting_approval: "Awaiting approval",
	running: "Running",
	pending: "Queued",
	skipped: "Skipped",
};

/** Ring segment + popover dot share one color, so the arc reads as the row. */
const STATUS_STROKE: Record<CiCheckStatus, string> = {
	passing: "stroke-success",
	failing: "stroke-destructive",
	awaiting_approval: "stroke-warning/80",
	running: "stroke-warning",
	pending: "stroke-muted-foreground/40",
	skipped: "stroke-muted-foreground/25",
};

const STATUS_DOT: Record<CiCheckStatus, string> = {
	passing: "bg-success",
	failing: "bg-destructive",
	awaiting_approval: "bg-warning",
	running: "bg-warning",
	pending: "bg-muted-foreground/40",
	skipped: "bg-muted-foreground/25",
};

const STATUS_ORDER: Record<CiCheckStatus, number> = {
	failing: 0,
	awaiting_approval: 1,
	running: 2,
	pending: 3,
	passing: 4,
	skipped: 5,
};

const VIEWBOX = 24;
const STROKE_WIDTH = 3;
const RADIUS = (VIEWBOX - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Visual breathing room between segments, in viewBox units. Shrinks so it can't eat a segment whole. */
const MAX_SEGMENT_GAP = 2.5;

/**
 * Human approval takes the headline whenever present, including mixed sets.
 */
function summarize(checks: readonly CiCheck[]): string {
	const awaiting = checks.filter(
		(check) => check.status === "awaiting_approval",
	).length;
	if (awaiting > 0)
		return `${awaiting} ${awaiting === 1 ? "workflow" : "workflows"} awaiting approval`;
	const failing = checks.filter((check) => check.status === "failing").length;
	if (failing > 0) return `${failing} failing`;

	const running = checks.filter((check) => check.status === "running").length;
	if (running > 0) return `${running} running`;

	const pending = checks.filter((check) => check.status === "pending").length;
	if (pending > 0) return `${pending} queued`;

	const passing = checks.filter((check) => check.status === "passing").length;
	if (passing === checks.length) return "All checks passed";

	return `${passing} passing`;
}

/**
 * One status for the whole set, with failures prominent in the compact trigger — what
 * `CiStatusIcon`'s single dot renders, since a commit row has no room for a
 * multi-segment ring.
 */
function overallStatus(checks: readonly CiCheck[]): CiCheckStatus {
	if (checks.some((check) => check.status === "failing")) return "failing";
	if (checks.some((check) => check.status === "awaiting_approval"))
		return "awaiting_approval";
	if (checks.some((check) => check.status === "running")) return "running";
	if (checks.some((check) => check.status === "pending")) return "pending";
	if (checks.some((check) => check.status === "passing")) return "passing";
	return "skipped";
}

/**
 * The popover's own contents — summary headline + per-check list — shared by
 * both `CiStatus`'s full ring badge and `CiStatusIcon`'s single-dot trigger
 * below, so the two triggers stay two small components rather than one
 * component branching on a variant prop.
 */
function CiChecksMenuContent({
	checks,
	onApproveWorkflows,
	isApproving,
}: {
	checks: readonly CiCheck[];
	onApproveWorkflows?: () => void;
	isApproving?: boolean;
}): React.ReactElement {
	const summary = summarize(checks);
	const awaitingChecks = checks.filter(
		(check) => check.status === "awaiting_approval",
	);
	const awaitingApproval = awaitingChecks.length > 0;
	return (
		<DropdownMenuContent align="end" className="w-72">
			<div className="px-2 py-1.5">
				<div className="flex items-baseline justify-between gap-2">
					<span className="font-medium text-xs">{summary}</span>
					<span className="text-muted-foreground text-xs">
						{checks.length} {checks.length === 1 ? "check" : "checks"}
					</span>
				</div>
				{awaitingApproval && (
					<p className="mt-1 text-muted-foreground text-xs">
						A maintainer must approve before these run.
					</p>
				)}
			</div>
			<DropdownMenuSeparator />
			{[...checks]
				.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
				.map((check) => {
					const detailsUrl = check.detailsUrl;
					return (
						<DropdownMenuItem
							disabled={detailsUrl === undefined}
							key={check.name}
							onClick={
								detailsUrl === undefined
									? undefined
									: () => void openUrl(detailsUrl)
							}
						>
							{check.status === "awaiting_approval" ? (
								<CirclePause className="size-3 shrink-0 text-warning" />
							) : (
								<span
									className={cn(
										"size-1.5 shrink-0 rounded-full",
										STATUS_DOT[check.status],
										check.status === "running" && "animate-pulse",
									)}
								/>
							)}
							<span className="min-w-0 flex-1 truncate">{check.name}</span>
							<span className="shrink-0 text-muted-foreground text-xs">
								{check.detail ?? STATUS_LABEL[check.status]}
							</span>
						</DropdownMenuItem>
					);
				})}
			{awaitingApproval && onApproveWorkflows !== undefined && (
				<>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						disabled={isApproving === true}
						onClick={onApproveWorkflows}
					>
						{isApproving === true
							? "Approving…"
							: `Approve ${awaitingChecks.length} ${awaitingChecks.length === 1 ? "workflow" : "workflows"}`}
					</DropdownMenuItem>
				</>
			)}
		</DropdownMenuContent>
	);
}

/**
 * One arc per check around a ring labeled "CI", click for the full list.
 *
 * Renders nothing when there are no checks — a PR with no CI configured
 * shouldn't get an empty ring implying something is still coming.
 */
export function CiStatus({
	checks,
	className,
	onApproveWorkflows,
	isApproving,
	watched,
}: WatchedCiStatusProps): React.ReactElement | null {
	const [open, setOpen] = useDismissOnInactive(watched);
	if (checks.length === 0) return null;

	const step = CIRCUMFERENCE / checks.length;
	// A single check gets an unbroken ring — a gap there would read as a second, missing check.
	const gap = checks.length === 1 ? 0 : Math.min(MAX_SEGMENT_GAP, step * 0.4);
	const segment = step - gap;
	const summary = summarize(checks);
	const awaitingApproval = checks.some(
		(check) => check.status === "awaiting_approval",
	);

	return (
		<DropdownMenu onOpenChange={setOpen} open={open}>
			<DropdownMenuTrigger
				aria-label={`CI: ${summary}`}
				className={cn(
					"flex h-7 shrink-0 items-center justify-center gap-1 rounded-md text-muted-foreground transition-colors hover:bg-accent data-popup-open:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
					className,
				)}
			>
				<svg
					aria-hidden="true"
					className="size-5.5"
					fill="none"
					viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
					xmlns="http://www.w3.org/2000/svg"
				>
					<g transform={`rotate(-90 ${VIEWBOX / 2} ${VIEWBOX / 2})`}>
						{[...checks]
							.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
							.map((check, index) => (
								<circle
									className={cn(
										STATUS_STROKE[check.status],
										check.status === "running" && "animate-pulse",
									)}
									cx={VIEWBOX / 2}
									cy={VIEWBOX / 2}
									key={check.name}
									r={RADIUS}
									strokeDasharray={`${segment} ${CIRCUMFERENCE - segment}`}
									strokeDashoffset={-index * step}
									strokeWidth={
										check.status === "awaiting_approval" ? 1.5 : STROKE_WIDTH
									}
								/>
							))}
					</g>
					{awaitingApproval ? (
						<Pause
							className="stroke-muted-foreground"
							height={10}
							width={10}
							x={VIEWBOX / 2 - 5}
							y={VIEWBOX / 2 - 5}
						/>
					) : (
						<text
							className="fill-foreground font-semibold text-[8px]"
							dominantBaseline="central"
							textAnchor="middle"
							x={VIEWBOX / 2}
							y={VIEWBOX / 2 + 0.5}
						>
							CI
						</text>
					)}
				</svg>
			</DropdownMenuTrigger>
			<CiChecksMenuContent
				checks={checks}
				isApproving={isApproving}
				onApproveWorkflows={onApproveWorkflows}
			/>
		</DropdownMenu>
	);
}

/**
 * A single small status dot, click for the same per-check popover `CiStatus`
 * offers — the Overview tab's commit rows need just this, not the full
 * multi-segment ring badge (there's no room for one, and a commit isn't the
 * PR-wide rollup the ring represents). Same "renders nothing for an empty
 * list" rule as `CiStatus`.
 */
export function CiStatusIcon({
	checks,
	className,
	onApproveWorkflows,
	isApproving,
}: CiStatusProps): React.ReactElement | null {
	if (checks.length === 0) return null;

	const summary = summarize(checks);
	const status = overallStatus(checks);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`CI: ${summary}`}
				className={cn(
					"flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent data-popup-open:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
					className,
				)}
			>
				<span
					className={cn(
						"size-2 shrink-0 rounded-full",
						STATUS_DOT[status],
						status === "running" && "animate-pulse",
					)}
				/>
			</DropdownMenuTrigger>
			<CiChecksMenuContent
				checks={checks}
				isApproving={isApproving}
				onApproveWorkflows={onApproveWorkflows}
			/>
		</DropdownMenu>
	);
}
