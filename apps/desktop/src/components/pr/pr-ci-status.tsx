"use client";

import type React from "react";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { PullRequestCheck } from "#/lib/pr-data";
import { usePullRequestChecks } from "#/lib/pr-data";
import type { CiCheck } from "./ci-status";
import { CiStatus } from "./ci-status";

type PrCiStatusProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

/** `"1m 12s"`/`"48s"` — the one place that decides how a check's run time reads, since neither the sidecar nor `@repo/git` should be minting English text. */
const formatDuration = (durationMs: number): string => {
	const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes === 0
		? `${seconds}s`
		: `${minutes}m ${String(seconds).padStart(2, "0")}s`;
};

/**
 * `gh` reports a `CheckRun`'s bare job name, and two different Actions
 * workflows can both define a job called (say) `test` — `CiStatus` keys its
 * ring segments and popover rows on `name`, so a collision there means
 * duplicate React keys, i.e. dropped/misrendered siblings, not just an
 * ambiguous label. Counts every check's `name` across the *whole* fetched
 * set so only the names that actually collide get qualified — a
 * single-workflow repo (the common case) shouldn't get `"CI / "` glued onto
 * every row for nothing, and this is the same rule GitHub's own PR UI uses.
 */
const countByName = (
	checks: readonly PullRequestCheck[],
): ReadonlyMap<string, number> => {
	const counts = new Map<string, number>();
	for (const check of checks) {
		counts.set(check.name, (counts.get(check.name) ?? 0) + 1);
	}
	return counts;
};

/**
 * `"<workflowName> / <name>"` when `name` collides with another check's and
 * there's a real (non-empty) `workflowName` to qualify it with; the bare
 * `name` otherwise. A `StatusContext` (no `workflowName`) or a non-Actions
 * `CheckRun` (`workflowName: ""`, GitHub's zero value) has nothing to
 * qualify with even if its name happens to collide — printing `" / <name>"`
 * would be worse than the ambiguity it's trying to fix.
 */
const displayName = (check: PullRequestCheck, isAmbiguous: boolean): string =>
	isAmbiguous && check.workflowName !== undefined && check.workflowName !== ""
		? `${check.workflowName} / ${check.name}`
		: check.name;

/** `pullRequests.checks`' wire row → `CiStatus`'s `CiCheck` prop shape — turns a fact (`durationMs`) into text, and disambiguates `name` against the rest of `checks`. */
const toCiChecks = (
	checks: readonly PullRequestCheck[],
): readonly CiCheck[] => {
	const counts = countByName(checks);
	return checks.map((check) => ({
		name: displayName(check, (counts.get(check.name) ?? 0) > 1),
		status: check.status,
		detail:
			check.durationMs === undefined
				? undefined
				: formatDuration(check.durationMs),
	}));
};

/**
 * Data-fetching wrapper around the purely presentational `CiStatus` —
 * renders `null` while `pullRequests.checks` is still loading and on error, a
 * PR whose checks failed to load must not show a ring implying real state
 * (unlike a genuinely empty check list, which `CiStatus` already renders as
 * nothing on its own).
 */
export function PrCiStatus({
	orpc,
	repoRoot,
	owner,
	repo,
	number,
}: PrCiStatusProps): React.ReactElement | null {
	const checksQuery = usePullRequestChecks(orpc, {
		repoRoot,
		owner,
		repo,
		number,
	});

	if (checksQuery.data === undefined) return null;

	return <CiStatus checks={toCiChecks(checksQuery.data)} />;
}
