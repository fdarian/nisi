"use client";

import { useLayoutEffect, useRef } from "react";
import type { OverviewCommit } from "#/lib/pr-data";
import { CommitRow } from "./commit-row";

type CommitListProps = {
	commits: readonly OverviewCommit[];
};

/**
 * The Overview tab's per-commit list, in the order `overview.get` returns
 * them (oldest at top, newest at bottom — matches GitHub's own PR Commits
 * tab). Scrolled to the bottom on mount so the newest commit and its CI
 * status are visible immediately on a long PR, without the reader having to
 * scroll for it.
 *
 * A layout effect assigning `scrollTop` directly against a ref, not
 * `requestAnimationFrame` — this component unmounts every time the Overview
 * sub-tab isn't the visible one (Base UI's `TabsPanel` defaults to
 * `keepMounted={false}`, same as `WalkthroughView`) and remounts fresh on
 * switching back, so a plain mount-time effect already re-runs exactly when
 * it needs to. Deliberately `[]` deps, not `[commits]` — this is a one-time
 * "land at the bottom" on mount, not a "keep pinned to the bottom on every
 * update" that would fight a reader who scrolled up to look at an earlier
 * commit while CI is still polling in the background.
 */
export function CommitList({ commits }: CommitListProps): React.ReactElement {
	const scrollRef = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const el = scrollRef.current;
		if (el === null) return;
		el.scrollTop = el.scrollHeight;
	}, []);

	return (
		<div className="min-h-0 flex-1 overflow-auto" ref={scrollRef}>
			<div className="flex flex-col divide-y">
				{commits.map((commit) => (
					<CommitRow commit={commit} key={commit.sha} />
				))}
			</div>
		</div>
	);
}
