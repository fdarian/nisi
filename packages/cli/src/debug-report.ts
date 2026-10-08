import type { DiagnosticsSnapshot } from "@repo/sidecar-api";

type SessionDiagnostics = DiagnosticsSnapshot["sessions"][number];

const shortSha = (sha: string) => sha.slice(0, 8);

const ago = (at: number, now: number) => {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 90) return `${seconds}s ago`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
};

/** Everything here is a reason to look closer, not necessarily a bug. */
export const sessionAnomalies = (session: SessionDiagnostics) => {
	const anomalies: string[] = [];
	if (!session.repoRootExists) anomalies.push("repoRoot is missing on disk");
	if (session.worktreeHeadError !== null)
		anomalies.push(`git rev-parse HEAD failed: ${session.worktreeHeadError}`);
	if (
		session.worktreeHead !== null &&
		session.headRefSha !== null &&
		session.worktreeHead !== session.headRefSha
	)
		anomalies.push(
			`worktree HEAD ${shortSha(session.worktreeHead)} differs from stored head ${session.headRef} (${shortSha(session.headRefSha)})`,
		);
	if (
		session.pr !== null &&
		!session.watched &&
		session.mergeStatus !== null &&
		session.mergeStatus.status.state === "OPEN" &&
		!session.mergeStatus.pollScheduled
	)
		anomalies.push(
			"open PR is unwatched with no poll scheduled, so its merge status will not refresh",
		);
	return anomalies;
};

const renderSession = (session: SessionDiagnostics, now: number) => {
	const subject =
		session.pr === null
			? session.headRef
			: `${session.pr.owner}/${session.pr.repo}#${session.pr.number}`;
	const lines = [
		`${session.sessionId}  ${subject}  ${session.watched ? "watched" : "unwatched"}`,
		`  repoRoot  ${session.repoRoot}${session.repoRootExists ? "" : "  (MISSING)"}`,
	];
	if (session.worktreeHead !== null)
		lines.push(
			`  head      worktree ${shortSha(session.worktreeHead)}, ${session.headRef} ${session.headRefSha === null ? "unresolved" : shortSha(session.headRefSha)}`,
		);
	if (session.pr !== null)
		lines.push(
			session.mergeStatus === null
				? "  merge     never read"
				: `  merge     ${session.mergeStatus.status.state} ${session.mergeStatus.status.mergeable} ${session.mergeStatus.status.mergeStateStatus}, changed ${ago(session.mergeStatus.changedAt, now)}, ${session.mergeStatus.pollScheduled ? "poll scheduled" : "no poll scheduled"}`,
		);
	for (const anomaly of sessionAnomalies(session)) lines.push(`  ! ${anomaly}`);
	return lines.join("\n");
};

export const renderSnapshot = (snapshot: DiagnosticsSnapshot, now: number) => {
	const anomalyCount =
		snapshot.sessions.reduce(
			(total, session) => total + sessionAnomalies(session).length,
			0,
		) + snapshot.rpcFailures.length;
	const sections = [
		`${snapshot.sessions.length} open session${snapshot.sessions.length === 1 ? "" : "s"}, ${anomalyCount} anomal${anomalyCount === 1 ? "y" : "ies"}`,
		...snapshot.sessions.map((session) => renderSession(session, now)),
	];
	if (snapshot.rpcFailures.length > 0)
		sections.push(
			[
				"! rpc failures since sidecar start",
				...snapshot.rpcFailures.map(
					(failure) =>
						`  ${failure.path}  ${failure.errorTag}  x${failure.count}, last ${ago(failure.lastAt, now)}: ${failure.lastMessage.split("\n")[0]}`,
				),
			].join("\n"),
		);
	return sections.join("\n\n");
};
