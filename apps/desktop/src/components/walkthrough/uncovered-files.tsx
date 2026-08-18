"use client";

import { ChevronRightIcon } from "lucide-react";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import type { UncoveredFile } from "#/lib/walkthrough-data";

type UncoveredFilesProps = {
	/**
	 * `undefined` — a walkthrough generated before this field existed, so
	 * coverage is unknown; renders nothing. `[]` — every changed line is
	 * covered. Non-empty — these files have changed lines no reference block
	 * claims. See `StoredWalkthrough.uncoveredFiles`'s doc.
	 */
	uncoveredFiles: readonly UncoveredFile[] | undefined;
};

function pluralize(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function lineCount(file: UncoveredFile): number {
	return file.ranges.reduce(
		(sum, range) => sum + (range.end - range.start + 1),
		0,
	);
}

/**
 * A quiet footnote under the reader's prose, not a warning — hunk coverage
 * used to be mandatory, forcing every changed line into a reference block;
 * now the agent decides what's worth narrating and is expected to collapse
 * noise into one honestly-labeled block instead (`@repo/walkthrough`'s
 * `coverage.ts` is informational, never a rejection reason). This is where a
 * reviewer finds out what got skipped. Collapsed by default: the trigger
 * summarizes the gap, expanding lists exactly which files and how many
 * lines. Deliberately plain — no icon, no tint — unlike `OutdatedBanner`'s
 * warning treatment, since nothing here is wrong.
 */
export function UncoveredFiles({
	uncoveredFiles,
}: UncoveredFilesProps): React.ReactElement | null {
	if (uncoveredFiles === undefined) return null;

	if (uncoveredFiles.length === 0) {
		return (
			<div className="border-t pt-4 text-muted-foreground text-xs">
				This walkthrough covers every changed line.
			</div>
		);
	}

	const totalLines = uncoveredFiles.reduce(
		(sum, file) => sum + lineCount(file),
		0,
	);

	return (
		<Collapsible className="border-t pt-4 text-muted-foreground text-xs">
			<CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1.5 text-left">
				<ChevronRightIcon className="size-3 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90" />
				<span>
					{pluralize(uncoveredFiles.length, "file")} not covered by this
					walkthrough · {pluralize(totalLines, "line")}
				</span>
			</CollapsibleTrigger>
			<CollapsibleContent>
				<ul className="flex flex-col gap-1 py-2 pl-[18px] font-mono text-[0.6875rem]">
					{uncoveredFiles.map((file) => (
						<li className="flex items-center gap-2" key={file.path}>
							<span className="min-w-0 flex-1 truncate">{file.path}</span>
							<span className="shrink-0 tabular-nums">
								{pluralize(lineCount(file), "line")}
							</span>
						</li>
					))}
				</ul>
			</CollapsibleContent>
		</Collapsible>
	);
}
