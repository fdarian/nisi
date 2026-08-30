"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import type React from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "#/components/ui/menu";
import { cn } from "#/lib/utils";

export type CiCheckStatus =
	| "passing"
	| "failing"
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
};

const STATUS_LABEL: Record<CiCheckStatus, string> = {
	passing: "Passing",
	failing: "Failing",
	running: "Running",
	pending: "Queued",
	skipped: "Skipped",
};

/** Ring segment + popover dot share one color, so the arc reads as the row. */
const STATUS_STROKE: Record<CiCheckStatus, string> = {
	passing: "stroke-success",
	failing: "stroke-destructive",
	running: "stroke-warning",
	pending: "stroke-muted-foreground/40",
	skipped: "stroke-muted-foreground/25",
};

const STATUS_DOT: Record<CiCheckStatus, string> = {
	passing: "bg-success",
	failing: "bg-destructive",
	running: "bg-warning",
	pending: "bg-muted-foreground/40",
	skipped: "bg-muted-foreground/25",
};

const VIEWBOX = 24;
const STROKE_WIDTH = 3;
const RADIUS = (VIEWBOX - STROKE_WIDTH) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
/** Visual breathing room between segments, in viewBox units. Shrinks so it can't eat a segment whole. */
const MAX_SEGMENT_GAP = 2.5;

/**
 * Headline the popover leads with. Failures outrank in-flight work, which
 * outranks everything settled — the reason you'd glance at this at all is to
 * find out whether the PR is blocked.
 */
function summarize(checks: readonly CiCheck[]): string {
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
 * One status for the whole set, same failing-outranks-running-outranks-
 * pending-outranks-settled priority `summarize` uses for its headline — what
 * `CiStatusIcon`'s single dot renders, since a commit row has no room for a
 * multi-segment ring.
 */
function overallStatus(checks: readonly CiCheck[]): CiCheckStatus {
	if (checks.some((check) => check.status === "failing")) return "failing";
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
}: {
	checks: readonly CiCheck[];
}): React.ReactElement {
	const summary = summarize(checks);
	return (
		<DropdownMenuContent align="end" className="w-72">
			<div className="flex items-baseline justify-between gap-2 px-2 py-1.5">
				<span className="font-medium text-xs">{summary}</span>
				<span className="text-muted-foreground text-xs">
					{checks.length} {checks.length === 1 ? "check" : "checks"}
				</span>
			</div>
			<DropdownMenuSeparator />
			{checks.map((check) => {
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
						<span
							className={cn(
								"size-1.5 shrink-0 rounded-full",
								STATUS_DOT[check.status],
								check.status === "running" && "animate-pulse",
							)}
						/>
						<span className="min-w-0 flex-1 truncate">{check.name}</span>
						<span className="shrink-0 text-muted-foreground text-xs">
							{check.detail ?? STATUS_LABEL[check.status]}
						</span>
					</DropdownMenuItem>
				);
			})}
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
}: CiStatusProps): React.ReactElement | null {
	if (checks.length === 0) return null;

	const step = CIRCUMFERENCE / checks.length;
	// A single check gets an unbroken ring — a gap there would read as a second, missing check.
	const gap = checks.length === 1 ? 0 : Math.min(MAX_SEGMENT_GAP, step * 0.4);
	const segment = step - gap;
	const summary = summarize(checks);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`CI: ${summary}`}
				className={cn(
					"flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent data-popup-open:bg-accent focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1",
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
						{checks.map((check, index) => (
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
								strokeWidth={STROKE_WIDTH}
							/>
						))}
					</g>
					<text
						className="fill-foreground font-semibold text-[8px]"
						dominantBaseline="central"
						textAnchor="middle"
						x={VIEWBOX / 2}
						y={VIEWBOX / 2 + 0.5}
					>
						CI
					</text>
				</svg>
			</DropdownMenuTrigger>
			<CiChecksMenuContent checks={checks} />
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
			<CiChecksMenuContent checks={checks} />
		</DropdownMenu>
	);
}
