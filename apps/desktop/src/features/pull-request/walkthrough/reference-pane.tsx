"use client";

import { BookOpenIcon } from "lucide-react";
import { useMemo } from "react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import type { FileChange } from "#/features/pull-request/data/pr-data";
import { LocationPane } from "#/features/pull-request/location-pane/location-pane";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import type { FileDrift, WalkthroughReferenceBlock } from "./walkthrough-data";

type ReferencePaneProps = {
	orpc: SidecarQueryUtils;
	sessionId: string;
	files: readonly FileChange[];
	block: WalkthroughReferenceBlock | null;
	changedPaths: ReadonlyMap<string, FileDrift>;
};

const EMPTY = (
	<Empty className="flex-1">
		<EmptyMedia variant="icon">
			<BookOpenIcon />
		</EmptyMedia>
		<EmptyTitle>No reference selected</EmptyTitle>
		<EmptyDescription>
			Click a link in the narrative to focus its code here.
		</EmptyDescription>
	</Empty>
);

/** The walkthrough's right pane: the selected reference block's code ranges, with "Outdated" on files edited or deleted since generation. */
export function ReferencePane(props: ReferencePaneProps): React.ReactElement {
	const outdatedPaths = useMemo(
		() =>
			new Set(
				Array.from(props.changedPaths)
					.filter(([, drift]) => drift === "edited" || drift === "deleted")
					.map(([path]) => path),
			),
		[props.changedPaths],
	);
	return (
		<LocationPane
			block={props.block}
			collapseReviewed
			empty={EMPTY}
			files={props.files}
			orpc={props.orpc}
			outdatedPaths={outdatedPaths}
			sessionId={props.sessionId}
		/>
	);
}
