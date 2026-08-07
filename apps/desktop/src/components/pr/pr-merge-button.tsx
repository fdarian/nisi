"use client";

import { ORPCError } from "@orpc/client";
import { CheckMenuItem, Menu } from "@tauri-apps/api/menu";
import { useCallback, useState } from "react";
import { Button } from "#/components/ui/button";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import type { MergeMethod, PullRequestMergeStatus } from "#/lib/pr-data";
import { useMergePullRequest, usePullRequestMergeStatus } from "#/lib/pr-data";

type PrMergeButtonProps = {
	orpc: SidecarQueryUtils;
	repoRoot: string;
	owner: string;
	repo: string;
	number: number;
};

const METHOD_LABEL: Record<MergeMethod, string> = {
	merge: "Merge pull request",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

const METHOD_MENU_LABEL: Record<MergeMethod, string> = {
	merge: "Merge",
	squash: "Squash and merge",
	rebase: "Rebase and merge",
};

/** `pullRequests.mergeStatus`'s declared contract errors already carry a plain-English message from the sidecar — anything else (network down, sidecar crash) has no authored message to show. */
const mergeStatusErrorMessage = (error: unknown): string => {
	if (error instanceof ORPCError && typeof error.message === "string") {
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return "Couldn't check whether this pull request can be merged.";
};

/**
 * Resolves the button's label/disabled/tooltip from `status` in the exact
 * priority order the design settled on — each check short-circuits the
 * ones below it, so e.g. a draft PR that's also behind base still reads
 * "Draft", not "Update branch required". `method` is only read by the
 * final, enabled branch; every branch above it (including the
 * `status`/`method` nullness guard) ignores which method is selected.
 */
const resolveButtonState = (
	status: PullRequestMergeStatus | undefined,
	isLoading: boolean,
	isError: boolean,
	error: unknown,
	isMerging: boolean,
	method: MergeMethod | null,
): { label: string; disabled: boolean; title?: string } => {
	if (isLoading || status?.mergeable === "UNKNOWN") {
		return { label: "Checking mergeability…", disabled: true };
	}
	if (isMerging) {
		return { label: "Merging…", disabled: true };
	}
	if (isError) {
		return {
			label: "Merge unavailable",
			disabled: true,
			title: mergeStatusErrorMessage(error),
		};
	}
	// No data and no error is a pending-but-not-fetching query (e.g. paused
	// while offline — `usePullRequestMergeStatus` has no `enabled` guard) —
	// still "not confirmed mergeable yet", not a green light. `method` is
	// checked alongside `status` since it's derived from the same data (see
	// `PrMergeButton`) and being `null` here means the same thing: nothing
	// loaded yet to merge with.
	if (status === undefined || method === null) {
		return { label: "Checking mergeability…", disabled: true };
	}
	if (status.state === "MERGED") {
		return { label: "Merged", disabled: true };
	}
	if (status.state === "CLOSED") {
		return { label: "Closed", disabled: true };
	}
	if (status.isDraft || status.mergeStateStatus === "DRAFT") {
		return { label: "Draft", disabled: true };
	}
	if (
		status.mergeable === "CONFLICTING" ||
		status.mergeStateStatus === "DIRTY"
	) {
		return { label: "Conflicts", disabled: true };
	}
	if (status.mergeStateStatus === "BLOCKED") {
		return { label: "Merge blocked", disabled: true };
	}
	if (status.mergeStateStatus === "BEHIND") {
		return { label: "Update branch required", disabled: true };
	}
	return { label: METHOD_LABEL[method], disabled: false };
};

/**
 * The PR header's Merge button — disabled until `mergeStatus` confirms the
 * PR can actually be merged (see `resolveButtonState`), left-click merges
 * immediately with the currently selected method (deliberately no
 * confirmation dialog), right-click opens a native menu to switch among the
 * repo's enabled methods.
 */
export function PrMergeButton({
	orpc,
	repoRoot,
	owner,
	repo,
	number,
}: PrMergeButtonProps): React.ReactElement {
	const statusQuery = usePullRequestMergeStatus(orpc, {
		repoRoot,
		owner,
		repo,
		number,
	});
	const { merge, isPending: isMerging } = useMergePullRequest(orpc);

	// Holds only the user's own context-menu pick — falls back to the
	// server's `defaultMethod` on every render until there is one, so a later
	// refetch (e.g. the one `useMergePullRequest` fires on success) never
	// overwrites a method the user already chose. `null` (no pick yet, no
	// status loaded yet) is a real state, not defaulted away — see
	// `resolveButtonState`'s explicit `method === null` guard and
	// `handleClick`'s bail-out below.
	const [selectedMethod, setSelectedMethod] = useState<MergeMethod | null>(
		null,
	);
	const method = selectedMethod ?? statusQuery.data?.defaultMethod ?? null;

	const { label, disabled, title } = resolveButtonState(
		statusQuery.data,
		statusQuery.isLoading,
		statusQuery.isError,
		statusQuery.error,
		isMerging,
		method,
	);

	const handleClick = useCallback(() => {
		if (disabled || method === null) return;
		merge({ repoRoot, owner, repo, number, method });
	}, [disabled, merge, repoRoot, owner, repo, number, method]);

	const handleContextMenu = useCallback(
		async (event: React.MouseEvent) => {
			event.preventDefault();
			// `ShellFrame` (`app-shell.tsx`) wires its own `onContextMenu` (the
			// DevTool toggle) all the way up at the shell root, so a React
			// synthetic right-click event here still bubbles up to it unless
			// stopped explicitly — `preventDefault()` alone only suppresses the
			// native browser context menu, not React's own event propagation.
			// Stopped before the `status === undefined` early return so a
			// right-click while merge status is still loading doesn't fall
			// through to the shell's menu either.
			event.stopPropagation();
			const status = statusQuery.data;
			if (status === undefined) return;

			const items = await Promise.all(
				status.allowedMethods.map((candidate) =>
					CheckMenuItem.new({
						checked: candidate === method,
						text: METHOD_MENU_LABEL[candidate],
						action: () => setSelectedMethod(candidate),
					}),
				),
			);
			const menu = await Menu.new({ items });
			await menu.popup();
		},
		[statusQuery.data, method],
	);

	return (
		<Button
			disabled={disabled}
			onClick={handleClick}
			onContextMenu={handleContextMenu}
			size="sm"
			title={title}
			variant="outline"
		>
			{label}
		</Button>
	);
}
