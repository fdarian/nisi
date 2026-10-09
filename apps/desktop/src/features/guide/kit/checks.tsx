"use client";

import type { GuideCheck } from "@repo/sidecar-api";
import { cn } from "cn";
import {
	CheckIcon,
	ChevronRightIcon,
	CircleMinusIcon,
	XIcon,
} from "lucide-react";
import { Children, isValidElement, type ReactNode, useState } from "react";
import { useGuideContext } from "../guide-context";

type SkippedProps = { title: string; children?: ReactNode };

/** A check deliberately not run, with the reason as children. Only meaningful inside `Checks`. */
export function Skipped(_props: SkippedProps): null {
	return null;
}

const SHORT_SHA = 7;

function CheckRow(props: {
	check: GuideCheck;
	stale: boolean;
}): React.ReactElement {
	const [open, setOpen] = useState(false);
	const passed = props.check.exitCode === 0;
	const Icon = passed ? CheckIcon : XIcon;
	return (
		<li className="border-b last:border-b-0">
			<button
				aria-expanded={open}
				className="flex w-full cursor-pointer items-start gap-2.5 px-3 py-2 text-left hover:bg-accent"
				onClick={() => setOpen(!open)}
				type="button"
			>
				<Icon
					aria-label={
						passed ? "Passed" : `Failed, exit ${props.check.exitCode}`
					}
					className={cn(
						"mt-0.5 size-4 shrink-0",
						passed ? "text-green-500" : "text-red-500",
					)}
				/>
				<span className="flex min-w-0 flex-1 flex-col">
					<span>{props.check.title}</span>
					<span className="flex flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
						<code className="break-all font-mono">{props.check.command}</code>
						<span className="shrink-0">
							at {props.check.sha.slice(0, SHORT_SHA)}
						</span>
						{props.check.dirty === true && (
							<span className="shrink-0">with uncommitted changes</span>
						)}
						{props.stale && (
							<span className="shrink-0 rounded bg-amber-500/12 px-1.5 text-[10px] text-amber-500 uppercase tracking-wide">
								stale
							</span>
						)}
					</span>
				</span>
				<ChevronRightIcon
					className={cn(
						"mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform",
						open && "rotate-90",
					)}
				/>
			</button>
			{open && (
				<pre className="m-0 max-h-72 overflow-auto border-t bg-background px-3 py-2 font-mono text-[11px] text-muted-foreground leading-relaxed">
					{props.check.output === "" ? "(no output)" : props.check.output}
				</pre>
			)}
		</li>
	);
}

/** Every command run recorded through `nisi guide check`, then any `Skipped` children. Results are never authored in prose: a run at an older commit than the session's head is marked stale. */
export function Checks(props: { children?: ReactNode }): React.ReactElement {
	const guide = useGuideContext();
	const skipped = Children.toArray(props.children).flatMap((child) =>
		isValidElement<SkippedProps>(child) && child.type === Skipped
			? [child.props]
			: [],
	);
	if (guide.checks.length === 0 && skipped.length === 0) {
		return (
			<div className="rounded-lg border bg-card px-3 py-2.5 text-muted-foreground text-xs">
				No checks recorded yet. Run them through{" "}
				<code className="font-mono">nisi guide check</code> to list them here.
			</div>
		);
	}
	return (
		<ul className="m-0 list-none overflow-hidden rounded-lg border bg-card p-0">
			{guide.checks.map((check) => (
				<CheckRow
					check={check}
					key={check.title}
					stale={check.sha !== guide.headSha}
				/>
			))}
			{skipped.map((entry) => (
				<li
					className="flex items-start gap-2.5 border-b px-3 py-2 last:border-b-0"
					key={entry.title}
				>
					<CircleMinusIcon
						aria-label="Not run"
						className="mt-0.5 size-4 shrink-0 text-amber-500"
					/>
					<span className="flex min-w-0 flex-col">
						<span>{entry.title}</span>
						{entry.children !== undefined && (
							<span className="text-muted-foreground text-xs">
								{entry.children}
							</span>
						)}
					</span>
				</li>
			))}
		</ul>
	);
}
