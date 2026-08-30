"use client";

import { AlertTriangleIcon } from "lucide-react";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import { Spinner } from "#/components/ui/spinner";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { Session } from "#/lib/pr-data";
import { useOverview } from "#/lib/pr-data";
import { CommitList } from "./commit-list";
import { DescriptionPane } from "./description-pane";

type OverviewViewProps = {
	orpc: SidecarQueryUtils;
	session: Session;
};

/**
 * The Overview tab: a PR session's description (GitHub comment layout) next
 * to its full commit list, or — for a branch/diff session, which has no PR
 * to describe — just the commit list, full width. `overview.description`
 * being `null` is what decides which layout renders; it's `null` in exactly
 * the branch-mode case (see `useOverview`'s doc comment), so there's no need
 * to separately branch on `session.target.kind` here. PR mode mirrors
 * `WalkthroughView`'s fixed-width two-pane shape (`walkthrough-view.tsx`).
 */
export function OverviewView({
	orpc,
	session,
}: OverviewViewProps): React.ReactElement {
	const overviewQuery = useOverview(orpc, session);

	if (overviewQuery.error != null) {
		return <OverviewError error={overviewQuery.error} />;
	}
	if (overviewQuery.data === undefined) {
		return <OverviewLoading />;
	}

	const overview = overviewQuery.data;

	return (
		<div className="flex min-w-0 min-h-0 flex-1 flex-col">
			{overview.description === null ? (
				// Branch/diff mode: no description pane, so the commits list gets
				// the full width instead of sitting in a narrow right column next
				// to an empty left half.
				<div className="mx-auto flex min-h-0 w-full max-w-2xl flex-1 flex-col space-y-1 pt-5">
					<p className="text-sm text-muted-foreground">Commits</p>
					<CommitList commits={overview.commits} />
				</div>
			) : (
				<div className="flex min-h-0 flex-1">
					<DescriptionPane description={overview.description} />
					<div className="flex min-h-0 w-[42%] max-w-2xl flex-col py-5 space-y-1 pr-3">
						<p className="text-sm text-muted-foreground">Commits</p>
						<CommitList commits={overview.commits} />
					</div>
				</div>
			)}
		</div>
	);
}

function OverviewLoading(): React.ReactElement {
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<Spinner className="size-5" />
			</EmptyMedia>
			<EmptyTitle>Loading overview…</EmptyTitle>
		</Empty>
	);
}

function OverviewError({ error }: { error: unknown }): React.ReactElement {
	const message = error instanceof Error ? error.message : String(error);
	return (
		<Empty className="flex-1">
			<EmptyMedia variant="icon">
				<AlertTriangleIcon />
			</EmptyMedia>
			<EmptyTitle>Couldn't load the overview</EmptyTitle>
			<EmptyDescription>{message}</EmptyDescription>
		</Empty>
	);
}
