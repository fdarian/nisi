import type { LaunchRecord } from "@repo/sidecar-api";

export function formatAlreadyOpen(
	records: readonly LaunchRecord[],
): string | undefined {
	const snapshot = records.find(
		(record) =>
			record.type === "mark" &&
			record.name === "measurement.sessions-before-open",
	);
	const opened = records.find(
		(record) => record.type === "span" && record.name === "sessions.open",
	);
	if (
		snapshot === undefined ||
		opened === undefined ||
		!Array.isArray(snapshot.attrs.sessionIds) ||
		typeof opened.attrs.sessionId !== "string" ||
		!snapshot.attrs.sessionIds.includes(opened.attrs.sessionId)
	)
		return undefined;
	return "PR was already open in this instance; list/diff timings may reflect cached data, not a fresh-render measurement.";
}

export function formatVisibility(
	records: readonly LaunchRecord[],
	observedAt: number,
): string | undefined {
	const marks = records.filter((record) => record.type === "mark");
	const requested = marks.find(
		(mark) =>
			mark.source === "frontend" &&
			["open-requested.received", "deeplink.received"].includes(mark.name),
	);
	const origin =
		marks.find((mark) =>
			["cli.process-start", "measurement.app-launch.start"].includes(mark.name),
		) ?? marks.find((mark) => mark.name === "deeplink.received");
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
			typeof mark.attrs.hidden !== "boolean" ||
			mark.at > end
		)
			continue;
		if (mark.attrs.hidden) {
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
		`Hidden intervals (+ms from ${origin.name === "cli.process-start" ? "CLI" : origin.name === "measurement.app-launch.start" ? "managed app launch" : "frontend deep-link receipt"}):`,
		...state.intervals.map(
			(interval) =>
				`  ${(interval.start - origin.at).toFixed(1)} → ${(interval.end - origin.at).toFixed(1)} (${(interval.end - interval.start).toFixed(1)} ms)${interval.ongoing ? (terminal === undefined ? " — still hidden at timeout" : " — hidden at terminal mark") : ""}`,
		),
	].join("\n");
}

export function formatTimeline(
	records: readonly LaunchRecord[],
	observedAt = Date.now(),
): string {
	const marks = records.filter((record) => record.type === "mark");
	const deepLink = marks.some((mark) => mark.name === "deeplink.received");
	const start = deepLink
		? (marks.find((mark) => mark.name === "measurement.app-launch.start") ??
			marks.find((mark) => mark.name === "deeplink.received"))
		: marks.find((mark) => mark.name === "cli.process-start");
	if (start === undefined)
		return "Missing cli.process-start; no timeline origin available.";
	const spans = records.filter((record) => record.type === "span");
	const alreadyOpen = formatAlreadyOpen(records);
	const states = [
		...marks,
		...spans
			.filter((span) => !["subprocess", "rpc"].includes(span.name))
			.flatMap((span) => [
				{
					at: span.start,
					source: span.source,
					name: `${span.name}.start`,
					attrs: span.attrs,
				},
				{
					at: span.end,
					source: span.source,
					name: `${span.name}.end`,
					attrs: span.attrs,
				},
			]),
	].sort((a, b) => a.at - b.at);
	const rows = states.map((mark, index) => {
		const previous = states[index - 1];
		return `${(mark.at - start.at).toFixed(1).padStart(10)} ${(previous === undefined ? "—" : (mark.at - previous.at).toFixed(1)).padStart(9)} ${mark.source.padEnd(8)} ${mark.name} ${JSON.stringify(mark.attrs)}`;
	});
	const milestones = [
		...(deepLink
			? [
					"deeplink.received",
					"deeplink.dequeued",
					"pull-requests.open.resolved",
				]
			: []),
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
		if (
			deepLink &&
			[
				"cli.app.launch.end",
				"sidecar.activation.acked",
				"pending-panel.painted",
			].includes(name)
		)
			return `${name}: N/A (deep-link flow)`;
		const operation =
			name === "cli.app.launch.end"
				? "cli.app.launch"
				: name === "sidecar.router.ready"
					? "sidecar.router.attach"
					: name === "sidecar.activation.acked"
						? "activation.acked"
						: undefined;
		if (operation !== undefined) {
			const span = spans.find((span) => span.name === operation);
			if (span === undefined) return `${name}: not observed`;
			return `${name}: ${(span.end - start.at).toFixed(1)} ms${span.end < start.at ? " (warm)" : ""}`;
		}
		const mark = marks.find((entry) => entry.name === name);
		if (mark === undefined) return `${name}: not observed`;
		return `${name}: ${(mark.at - start.at).toFixed(1)} ms${mark.at < start.at ? " (warm)" : ""}`;
	});
	const byId = new Map(spans.map((span) => [span.spanId, span]));
	const depth = (span: (typeof spans)[number]): number => {
		const state = { span, depth: 0 };
		const seen = new Set<string>();
		while (state.span.parentSpanId !== undefined) {
			if (seen.has(state.span.spanId))
				throw new Error("Cyclic launch span parents");
			seen.add(state.span.spanId);
			const parent = byId.get(state.span.parentSpanId);
			if (parent === undefined) break;
			state.span = parent;
			state.depth += 1;
		}
		return state.depth;
	};
	const row = (span: (typeof spans)[number]) =>
		`${(span.start - start.at).toFixed(1).padStart(10)} ${(span.end - span.start).toFixed(1).padStart(9)} ${"  ".repeat(depth(span))}${span.source} ${span.name}${span.attrs.command === undefined && span.attrs.path === undefined ? "" : ` ${String(span.attrs.command ?? span.attrs.path)}`}${span.attrs.args === undefined ? "" : ` ${JSON.stringify(span.attrs.args)}`}`;
	const slowest = spans
		.filter(
			(span) =>
				["subprocess", "rpc"].includes(span.name) &&
				!spans.some((child) => child.parentSpanId === span.spanId),
		)
		.sort((a, b) => b.end - b.start - (a.end - a.start));
	const visibility = formatVisibility(records, observedAt);
	return [
		...(alreadyOpen === undefined ? [] : [alreadyOpen, ""]),
		`Timeline (+ms from ${deepLink ? (start.name === "measurement.app-launch.start" ? "managed app launch" : "frontend deep-link receipt") : "CLI"}, Δ previous, source, name, attrs)`,
		...rows,
		"",
		"Milestones",
		...summary,
		...(visibility === undefined ? [] : ["", visibility]),
		"",
		"Waterfall (+ms, duration ms, spans indented by parent depth)",
		...[...spans]
			.sort((a, b) => a.start - b.start || depth(a) - depth(b))
			.map(row),
		"",
		"Slowest first",
		...slowest.slice(0, 15).map(row),
		"",
		marks.some((mark) => mark.name === "trace.done") &&
		marks.some((mark) => mark.name === "tab.content.painted")
			? "Complete"
			: "INCOMPLETE: missing tab.content.painted / trace.done",
	].join("\n");
}
