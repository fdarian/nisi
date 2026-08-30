"use client";

import { openUrl } from "@tauri-apps/plugin-opener";
import type React from "react";
import { CiStatusIcon } from "#/components/pr/ci-status";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import type { OverviewCommit } from "#/lib/pr-data";
import { githubAvatarUrl } from "#/lib/pull-requests-data";

/** Mirrors `open-pull-request-palette.tsx`'s helper of the same name — too small (one line) to be worth sharing across the two files. */
function authorInitials(name: string): string {
	return name.slice(0, 2).toUpperCase();
}

type CommitRowProps = {
	commit: OverviewCommit;
};

/**
 * One row in the Overview tab's commit list: avatar, then the headline, then
 * right-aligned CI status followed by the short hash — both pinned right so
 * a long headline truncates before either. Inert otherwise: no click
 * handler, no inline body expansion. `commit.checks` is `null` whenever
 * GitHub reports no CI rollup for this commit (always true in branch mode),
 * which is normal, not an error — no status indicator renders for it.
 */
export function CommitRow({ commit }: CommitRowProps): React.ReactElement {
	return (
		<div className="flex items-center gap-2.5 py-2">
			<Avatar className="size-6 shrink-0 text-[10px]">
				{commit.authorLogin !== null && (
					<AvatarImage alt="" src={githubAvatarUrl(commit.authorLogin)} />
				)}
				<AvatarFallback>{authorInitials(commit.authorName)}</AvatarFallback>
			</Avatar>
			<span className="min-w-0 flex-1 truncate text-foreground text-sm">
				{commit.headline}
			</span>
			<div className="flex shrink-0 items-center gap-1">
				{commit.checks !== null && <CiStatusIcon checks={commit.checks} />}
				<CommitHashLink shortSha={commit.shortSha} url={commit.url} />
			</div>
		</div>
	);
}

/**
 * The short hash, linking to the commit on GitHub — `openUrl`
 * (`@tauri-apps/plugin-opener`), the same way `command-palette.tsx`'s "Open
 * Pull Request in GitHub" and `ci-status.tsx`'s check rows open an external
 * URL, rather than a bare `<a target="_blank">`. Plain, non-interactive text
 * when `url` is `null` (branch mode has no GitHub commit to link to).
 */
function CommitHashLink({
	shortSha,
	url,
}: {
	shortSha: string;
	url: string | null;
}): React.ReactElement {
	if (url === null) {
		return (
			<span className="font-mono text-muted-foreground text-xs">
				{shortSha}
			</span>
		);
	}
	return (
		<button
			className="cursor-pointer font-mono text-muted-foreground text-xs hover:text-foreground hover:underline hover:underline-offset-2"
			onClick={() => void openUrl(url)}
			type="button"
		>
			{shortSha}
		</button>
	);
}
