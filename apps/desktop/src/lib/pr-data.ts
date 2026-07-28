/**
 * The Phase 1 data seam. Shapes mirror PLAN.md's contract exactly (`Session`,
 * `FileChange`) so swapping the bodies below for real oRPC calls
 * (`orpc.sessions.list`, `orpc.diff.files`, ...) is a one-file change — every
 * consumer already depends only on these hook signatures.
 *
 * `ReviewState` is the one type here with no backend yet: Phase 2 computes it
 * from real `base`/`reviewed`/`head` snapshot reconciliation. Until then
 * `useReviewState` returns fixture data so the sidebar's muted/orange-dot
 * rendering has something to react to.
 */
import { useCallback, useMemo, useState } from "react";
import {
	FIXTURE_FILE_CHANGES,
	FIXTURE_REVIEW_STATE,
	FIXTURE_SESSIONS,
} from "#/fixtures/pull-requests";

export type PullRequestInfo = {
	number: number;
	title: string;
	baseRef: string;
	headRef: string;
	owner: string;
	repo: string;
};

export type Session = {
	id: string;
	repoRoot: string;
	pr: PullRequestInfo | null;
};

export type FileStatus = "added" | "modified" | "deleted" | "renamed";
export type FileCategory = "implementation" | "test" | "generated";

export type FileChange = {
	path: string;
	oldPath?: string;
	status: FileStatus;
	category: FileCategory;
	additions: number;
	deletions: number;
	fingerprint: string;
	binary: boolean;
};

export type ReviewState = "unreviewed" | "viewed" | "changed-after-review";

/** Mirrors `sessions.list()` plus a `sessions.close`-shaped mutation. */
export function useSessions(): {
	sessions: Session[];
	closeSession: (sessionId: string) => void;
} {
	const [openSessionIds, setOpenSessionIds] = useState(
		() => new Set(FIXTURE_SESSIONS.map((session) => session.id)),
	);

	const sessions = useMemo(
		() => FIXTURE_SESSIONS.filter((session) => openSessionIds.has(session.id)),
		[openSessionIds],
	);

	const closeSession = useCallback((sessionId: string) => {
		setOpenSessionIds((current) => {
			const next = new Set(current);
			next.delete(sessionId);
			return next;
		});
	}, []);

	return { sessions, closeSession };
}

/** Mirrors `diff.files({ sessionId })` — metadata for every file in the PR. */
export function useFileChanges(sessionId: string): FileChange[] {
	return useMemo(() => FIXTURE_FILE_CHANGES[sessionId] ?? [], [sessionId]);
}

/** Stand-in for Phase 2's tracked-changes reconciliation. See module doc. */
export function useReviewState(
	sessionId: string,
): ReadonlyMap<string, ReviewState> {
	return useMemo(
		() => FIXTURE_REVIEW_STATE[sessionId] ?? new Map(),
		[sessionId],
	);
}
