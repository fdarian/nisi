"use client";

import {
	AlertTriangleIcon,
	FileMinusIcon,
	FilePenIcon,
	FilePlusIcon,
} from "lucide-react";
import { RegenerateControl } from "#/components/walkthrough/regenerate-control";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { FileDrift, HarnessId } from "#/lib/walkthrough-data";

type OutdatedBannerProps = {
	changedPaths: ReadonlyMap<string, FileDrift>;
	orpc: SidecarQueryUtils;
	/** The harness/model the *current* stored walkthrough was generated with — the picker's default, so Regenerate reads as "do it again" rather than forcing a fresh choice every time. */
	defaultHarness: HarnessId;
	defaultModel: string | null;
	onRegenerate: (harness: HarnessId, model: string | undefined) => void;
};

const DRIFT_LABEL: Record<FileDrift, string> = {
	deleted: "Deleted",
	edited: "Edited",
	new: "New",
};

const DRIFT_ICON: Record<FileDrift, typeof FilePlusIcon> = {
	deleted: FileMinusIcon,
	edited: FilePenIcon,
	new: FilePlusIcon,
};

/**
 * What's changed in the worktree since this walkthrough was generated —
 * driven by comparing `StoredWalkthrough.fingerprints` against the session's
 * current `diff.files` (`useWalkthroughDrift`). Hidden entirely when nothing
 * has drifted. Regenerate is `RegenerateControl` — the same harness/model
 * picker paired with the button that `NarrativePane`'s persistent footer
 * also renders — defaulting to whatever produced the walkthrough currently
 * on screen.
 */
export function OutdatedBanner({
	changedPaths,
	orpc,
	defaultHarness,
	defaultModel,
	onRegenerate,
}: OutdatedBannerProps): React.ReactElement | null {
	if (changedPaths.size === 0) return null;
	const entries = Array.from(changedPaths.entries());

	return (
		<div className="flex shrink-0 flex-col gap-2 border-b bg-warning/8 px-4 py-3 dark:bg-warning/16">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 text-warning-foreground text-xs">
					<AlertTriangleIcon className="size-3.5" />
					<span className="font-medium">
						{entries.length} {entries.length === 1 ? "file has" : "files have"}{" "}
						changed since this walkthrough was generated
					</span>
				</div>
				<RegenerateControl
					defaultHarness={defaultHarness}
					defaultModel={defaultModel}
					onRegenerate={onRegenerate}
					orpc={orpc}
				/>
			</div>
			<ul className="flex flex-col gap-1">
				{entries.map(([path, drift]) => {
					const Icon = DRIFT_ICON[drift];
					return (
						<li
							className="flex items-center gap-2 font-mono text-[0.6875rem] text-muted-foreground"
							key={path}
						>
							<Icon className="size-3 shrink-0" />
							<span className="truncate">{path}</span>
							<span className="shrink-0 text-warning-foreground">
								{DRIFT_LABEL[drift]}
							</span>
						</li>
					);
				})}
			</ul>
		</div>
	);
}
