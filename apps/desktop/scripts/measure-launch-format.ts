import type { LaunchMark } from "../sidecar/launch-trace/file-writer.ts";

export function formatTimeline(marks: readonly LaunchMark[]): string {
	const start = marks.find((mark) => mark.name === "cli.process-start");
	if (start === undefined)
		return "Missing cli.process-start; no timeline origin available.";
	const sorted = [...marks].sort((a, b) => a.at - b.at);
	const rows = sorted.map((mark, index) => {
		const previous = sorted[index - 1];
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
			mark.name === "spawn" ||
			mark.name === "rpc" ||
			(mark.name === "spawn.start" &&
				!sorted.some((end) => end.name === "spawn" && end.at === mark.at)) ||
			(mark.name === "rpc.start" &&
				!sorted.some((end) => end.name === "rpc" && end.rpcId === mark.rpcId)),
	);
	const span = (mark: LaunchMark) =>
		`${(mark.at - start.at).toFixed(1).padStart(10)} ${typeof mark.durationMs === "number" ? mark.durationMs.toFixed(1).padStart(9) : "pending"} ${String(mark.command ?? mark.path)} ${mark.args === undefined ? "" : JSON.stringify(mark.args)}`;
	const slowest = [...spans].sort(
		(a, b) =>
			(typeof b.durationMs === "number" ? b.durationMs : -1) -
			(typeof a.durationMs === "number" ? a.durationMs : -1),
	);
	return [
		"Timeline (+ms from CLI, Δ previous, source, name, attrs)",
		...rows,
		"",
		"Milestones",
		...summary,
		"",
		"Waterfall (+ms, duration ms, command/RPC)",
		...spans.map(span),
		"",
		"Slowest first",
		...slowest.map(span),
		"",
		marks.some((mark) => mark.name === "trace.done") &&
		marks.some((mark) => mark.name === "tab.content.painted")
			? "Complete"
			: "INCOMPLETE: missing tab.content.painted / trace.done",
	].join("\n");
}
