"use client";

import { Tabs } from "#/components/ui/tabs";
import { FilesChangedSkeleton } from "#/features/pull-request/files/files-changed-skeleton";
import { useWalkthroughEnabled } from "#/features/settings/settings-data";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { PrHeaderSkeleton } from "./header/pr-header-skeleton";
import {
	PR_VIEW_TABS_CLASS,
	PrViewTabStripSkeleton,
	prViewTabs,
} from "./pr-view-tab-strip";

/**
 * What the pending-open tab shows until its session exists: the same header,
 * tab strip and Files Changed layout `PrView` will mount, with the data
 * missing. `PrView` has to be able to replace this without anything moving, so
 * every piece is the real component or its skeleton twin, never a lookalike.
 */
export function PendingPrView(props: {
	orpc: SidecarQueryUtils;
	pullRequest?: { owner: string; repo: string; number: number };
	/** Whether this panel is on screen; a hidden tab must not record a launch paint. */
	visible: boolean;
}): React.ReactElement {
	const [walkthroughEnabled] = useWalkthroughEnabled(props.orpc);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<PrHeaderSkeleton pullRequest={props.pullRequest} />
			<Tabs className={PR_VIEW_TABS_CLASS} value="files">
				<PrViewTabStripSkeleton tabs={prViewTabs(walkthroughEnabled)} />
				<FilesChangedSkeleton orpc={props.orpc} when={props.visible} />
			</Tabs>
		</div>
	);
}
