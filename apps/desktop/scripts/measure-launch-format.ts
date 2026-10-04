import type { LaunchMark } from "../sidecar/launch-trace/file-writer.ts";

export function formatVisibility(
	marks: readonly LaunchMark[],
	observedAt: number,
): string | undefined {
	const requested = marks.find(
		(mark) =>
			mark.source === "frontend" && mark.name === "open-requested.received",
	);
	const origin = marks.find((mark) => mark.name === "cli.process-start");
	if (requested === undefined || origin === undefined) return undefined;
	const terminal = marks.find(
		(mark) => mark.source === "frontend" && mark.name === "tab.content.painted",
	);
	const end = terminal === undefined ? observedAt : terminal.at;
	const state: {
		hiddenSince?: number;
		intervals: { start: number; end: number; ongoing: boolean }[];
	} = { intervals: [] };
	for (const mark of [...marks].sort((a, b) => a.at - b.at)) {
		if (
			mark.source !== "frontend" ||
			mark.name !== "frontend.visibility" ||
			typeof mark.hidden !== "boolean" ||
			mark.at > end
		)
			continue;
		if (mark.hidden) {
			if (state.hiddenSince === undefined)
				state.hiddenSince = Math.max(requested.at, mark.at);
		} else if (state.hiddenSince !== undefined) {
			if (mark.at >= requested.at)
				state.intervals.push({
					start: state.hiddenSince,
					end: mark.at,
					ongoing: false,
				});
			state.hiddenSince = undefined;
		}
	}
	if (state.hiddenSince !== undefined)
		state.intervals.push({ start: state.hiddenSince, end, ongoing: true });
	if (state.intervals.length === 0) return undefined;
	const duration = state.intervals.reduce(
		(total, interval) => total + interval.end - interval.start,
		0,
	);
	return [
		`window was hidden for ${duration.toFixed(1)} ms (screen locked / window occluded) — paint timings include that wait`,
		"Hidden intervals (+ms from CLI):",
		...state.intervals.map(
			(interval) =>
				`  ${(interval.start - origin.at).toFixed(1)} → ${(interval.end - origin.at).toFixed(1)} (${(interval.end - interval.start).toFixed(1)} ms)${interval.ongoing ? (terminal === undefined ? " — still hidden at timeout" : " — hidden at terminal mark") : ""}`,
		),
	].join("\n");
}

export function formatTimeline(
	marks: readonly LaunchMark[],
	observedAt = Date.now(),
): string {
	const start = marks.find((mark) => mark.name === "cli.process-start");
	if (start === undefined)
		return "Missing cli.process-start; no timeline origin available.";
	const sorted = [...marks].sort((a, b) => a.at - b.at);
	const states = sorted.filter(
		(mark) => !["spawn.start", "spawn", "rpc.start", "rpc"].includes(mark.name),
	);
	const rows = states.map((mark, index) => {
		const previous = states[index - 1];
		const attrs = Object.fromEntries(
			Object.entries(mark).filter(
				(entry) => !["at", "source", "name"].includes(entry[0]),
			),
		);
		return `${(mark.at - start.at).toFixed(1).padStart(10)} ${(previous === undefined ? "—" : (mark.at - previous.at).toFixed(1)).padStart(9)} ${mark.source.padEnd(8)} ${mark.name} ${JSON.stringify(attrs)}`;
	});
	const milestones = [
		"cli.app.launch.end",
		"sidecar.router.ready",
		"sidecar.activation.acked",
		"pending-panel.painted",
		"files.loading.painted",
		"files.list.painted",
		"files.first-diff.painted",
		"overview.loading.painted",
		"tab.content.painted",
	];
	const summary = milestones.map((name) => {
		const mark = marks.find((entry) => entry.name === name);
		if (mark === undefined) return `${name}: not observed`;
		return `${name}: ${(mark.at - start.at).toFixed(1)} ms${mark.at < start.at ? " (warm)" : ""}`;
	});
	const spans = sorted.filter(
		(mark) =>
			mark.path !== "/api/diagnostics/launchMarks" &&
			(mark.name === "spawn" ||
				mark.name === "rpc" ||
				(mark.name === "spawn.start" &&
					!sorted.some((end) => end.name === "spawn" && end.at === mark.at)) ||
				(mark.name === "rpc.start" &&
					!sorted.some(
						(end) => end.name === "rpc" && end.rpcId === mark.rpcId,
					))),
	);
	const span = (mark: LaunchMark) =>
		`${(mark.at - start.at).toFixed(1).padStart(10)} ${typeof mark.durationMs === "number" ? mark.durationMs.toFixed(1).padStart(9) : "pending"} ${String(mark.command ?? mark.path)} ${mark.args === undefined ? "" : JSON.stringify(mark.args)}`;
	const slowest = [...spans].sort(
		(a, b) =>
			(typeof b.durationMs === "number" ? b.durationMs : -1) -
			(typeof a.durationMs === "number" ? a.durationMs : -1),
	);
	const visibility = formatVisibility(marks, observedAt);
	return [
		"Timeline (+ms from CLI, Δ previous, source, name, attrs)",
		...rows,
		"",
		"Milestones",
		...summary,
		...(visibility === undefined ? [] : ["", visibility]),
		"",
		"Waterfall (+ms, duration ms, command/RPC)",
		...spans.map(span),
		"",
		"Slowest first",
		...slowest.slice(0, 15).map(span),
		"",
		marks.some((mark) => mark.name === "trace.done") &&
		marks.some((mark) => mark.name === "tab.content.painted")
			? "Complete"
			: "INCOMPLETE: missing tab.content.painted / trace.done",
	].join("\n");
}
