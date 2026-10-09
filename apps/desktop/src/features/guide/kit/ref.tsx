"use client";

import { cn } from "cn";
import { TriangleAlertIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "#/components/ui/tooltip";
import { ProseCode } from "#/features/pull-request/prose-markdown";
import { splitPath } from "#/lib/tree-paths";
import { useGuideContext } from "../guide-context";
import { parseLines, refFromCode, sameRef } from "../refs";

/** Opens `path` (at `lines`, e.g. "12-30") in the Guide's side pane, next to the text that cites it. */
export function Ref(props: {
	path: string;
	lines?: string;
	/** Replaces the basename as the visible text; `Areas` passes a longer suffix when two listed files share a name. */
	label?: string;
	/** Set by `GuideCode` for a backticked path; lets the validator spot a path cited both ways in one paragraph. Authors never pass it. */
	autolinked?: boolean;
}): React.ReactElement {
	const guide = useGuideContext();
	if (props.lines !== undefined) parseLines(props.lines);
	guide.collector?.refs.push({ path: props.path, lines: props.lines });
	const inDiff = guide.changedPaths.has(props.path);
	const basename = props.label ?? splitPath(props.path).basename;
	const label =
		props.lines === undefined ? basename : `${basename}:${props.lines}`;
	const selected = sameRef(guide.selectedRef, props);
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<button
						data-text="ref"
						data-ref-path={props.path}
						data-ref-autolinked={props.autolinked === true ? "" : undefined}
						className={cn(
							"inline-flex max-w-full cursor-pointer items-center gap-1 rounded px-1.5 py-px align-baseline font-mono text-[10.5px] text-sky-500",
							selected ? "bg-sky-500/25" : "bg-sky-500/10 hover:bg-sky-500/20",
						)}
						onClick={() =>
							guide.selectRef({ path: props.path, lines: props.lines })
						}
						type="button"
					>
						<span className="truncate">{label}</span>
						{!inDiff && (
							<span className="inline-flex shrink-0 items-center gap-0.5 text-amber-500">
								<TriangleAlertIcon className="size-3" />
								not in diff
							</span>
						)}
					</button>
				}
			/>
			<TooltipPopup>
				<span className="font-mono">
					{props.lines === undefined
						? props.path
						: `${props.path}:${props.lines}`}
				</span>
			</TooltipPopup>
		</Tooltip>
	);
}

/** MDX's inline `code`: a backticked changed path (or `path:lines`) is a `Ref`; every other code span, and fenced code, keeps the app's prose styling. */
export function GuideCode(
	props: React.ComponentProps<"code">,
): React.ReactElement {
	const guide = useGuideContext();
	if (props.className === undefined && typeof props.children === "string") {
		const ref = refFromCode(props.children, guide.changedPaths);
		if (ref !== null) return <Ref {...ref} autolinked />;
	}
	return <ProseCode {...props} />;
}
