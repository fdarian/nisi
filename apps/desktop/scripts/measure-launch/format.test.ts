import { expect, test } from "bun:test";
import type { LaunchRecord } from "@repo/sidecar-api";
import {
	formatAlreadyOpen,
	formatTimeline,
	formatVisibility,
} from "./format.ts";

const mark = (
	at: number,
	name: string,
	attrs: Record<string, unknown> = {},
): LaunchRecord => ({
	type: "mark",
	source: name === "cli.process-start" ? "cli" : "frontend",
	at,
	name,
	attrs,
});
const span = (
	name: string,
	start: number,
	end: number,
	spanId: string,
	parentSpanId?: string,
	attrs: Record<string, unknown> = {},
): LaunchRecord => ({
	type: "span",
	source: "sidecar",
	name,
	start,
	end,
	spanId,
	parentSpanId,
	attrs,
});

test("deep-link hidden intervals retain their correct receipt origin", () => {
	const report = formatVisibility(
		[
			mark(100, "deeplink.received"),
			mark(110, "frontend.visibility", { hidden: true }),
			mark(160, "frontend.visibility", { hidden: false }),
			mark(200, "tab.content.painted"),
		],
		200,
	);
	expect(report).toContain("hidden for 50.0 ms");
	expect(report).toContain("+ms from frontend deep-link receipt");
});

test("already-open reports warn without inferring cache state from identical paint times", () => {
	const records = [
		mark(100, "cli.process-start"),
		mark(99, "measurement.sessions-before-open", { sessionIds: ["existing"] }),
		span("sessions.open", 110, 120, "open", undefined, {
			sessionId: "existing",
		}),
		mark(130, "files.list.painted"),
		mark(130, "files.first-diff.painted"),
	];
	expect(formatTimeline(records)).toContain(
		"PR was already open in this instance; list/diff timings may reflect cached data",
	);
	expect(
		formatAlreadyOpen(
			records.filter(
				(record) => record.name !== "measurement.sessions-before-open",
			),
		),
	).toBeUndefined();
	expect(
		formatAlreadyOpen([
			mark(99, "measurement.sessions-before-open", { sessionIds: ["other"] }),
			span("sessions.open", 110, 120, "open", undefined, { sessionId: "new" }),
		]),
	).toBeUndefined();
});

test("sorts wall clocks, remaps warm boot and indents children", () => {
	const result = formatTimeline([
		mark(100, "cli.process-start"),
		span("sidecar.router.attach", 40, 50, "router"),
		span("sessions.open", 110, 155, "open"),
		span("session.target.resolve", 120, 150, "target", "open"),
		span("subprocess", 130, 150, "gh", "target", {
			command: "gh",
			args: ["pr", "view"],
		}),
		mark(160, "tab.content.painted", { tab: "files" }),
		mark(161, "trace.done"),
	]);
	expect(result).toContain("sidecar.router.ready: -50.0 ms (warm)");
	expect(result).toContain("tab.content.painted: 60.0 ms");
	expect(result).toContain('20.0     sidecar subprocess gh ["pr","view"]');
	const timeline = result.slice(0, result.indexOf("Milestones"));
	expect(timeline).not.toContain("subprocess");
	expect(timeline).toContain("session.target.resolve.start");
	expect(result).toEndWith("Complete");
});

test("slowest list includes only leaf subprocesses/RPCs, capped at fifteen", () => {
	const result = formatTimeline([
		mark(100, "cli.process-start"),
		span("rpc", 105, 200, "parent", undefined, { path: "/api/parent" }),
		span("subprocess", 110, 115, "child", "parent", { command: "git" }),
		...Array.from({ length: 20 }, (_, index) =>
			span("rpc", 110, 110 + index + 1, `rpc-${index}`, undefined, {
				path: `/api/call-${index + 1}`,
			}),
		),
	]);
	const timeline = result.slice(0, result.indexOf("Milestones"));
	expect(timeline).not.toContain("rpc");
	const slowest = result.slice(
		result.indexOf("Slowest first\n") + "Slowest first\n".length,
		result.indexOf("\n\nINCOMPLETE"),
	);
	expect(slowest.split("\n")).toHaveLength(15);
	expect(slowest).toContain("/api/call-20");
	expect(slowest).not.toContain("/api/parent");
	expect(slowest).not.toContain("/api/call-5");
});

test("does not invent an origin or claim incomplete traces succeeded", () => {
	expect(formatTimeline([])).toContain("Missing cli.process-start");
	expect(formatTimeline([mark(100, "cli.process-start")])).toContain(
		"INCOMPLETE",
	);
});

test("reports every hidden interval, sorting and deduplicating visibility", () => {
	const result = formatTimeline(
		[
			mark(100, "cli.process-start"),
			mark(120, "open-requested.received"),
			mark(190, "frontend.visibility", { hidden: false }),
			mark(130, "frontend.visibility", { hidden: true }),
			mark(140, "frontend.visibility", { hidden: true }),
			mark(210, "frontend.visibility", { hidden: true }),
			mark(230, "frontend.visibility", { hidden: false }),
			mark(250, "tab.content.painted"),
			mark(251, "trace.done"),
			mark(260, "frontend.visibility", { hidden: true }),
		],
		1000,
	);
	expect(result).toContain("window was hidden for 80.0 ms");
	expect(result).toContain("30.0 → 90.0 (60.0 ms)");
	expect(result).toContain("110.0 → 130.0 (20.0 ms)");
	expect(result).not.toContain("still hidden at timeout");
});

test("extends hidden intervals to timeout rather than the last event", () => {
	const result = formatTimeline(
		[
			mark(100, "cli.process-start"),
			mark(120, "open-requested.received"),
			mark(121, "frontend.visibility", { hidden: true }),
			mark(130, "open-resolved.received"),
		],
		600,
	);
	expect(result).toContain("21.0 → 500.0 (479.0 ms) — still hidden at timeout");
	expect(result).toContain("INCOMPLETE");
});

test("clips initial hidden state and closes at terminal paint", () => {
	expect(
		formatVisibility(
			[
				mark(100, "cli.process-start"),
				mark(110, "frontend.visibility", { hidden: true }),
				mark(120, "open-requested.received"),
				mark(150, "tab.content.painted"),
			],
			600,
		),
	).toContain("20.0 → 50.0 (30.0 ms) — hidden at terminal mark");
});

test("does not warn for visible, missing, or out-of-window visibility", () => {
	const records = [
		mark(100, "cli.process-start"),
		mark(120, "open-requested.received"),
		mark(150, "tab.content.painted"),
	];
	expect(formatVisibility(records, 600)).toBeUndefined();
	expect(
		formatVisibility(
			[
				...records,
				mark(105, "frontend.visibility", { hidden: true }),
				mark(110, "frontend.visibility", { hidden: false }),
				mark(121, "frontend.visibility", { hidden: false }),
				mark(160, "frontend.visibility", { hidden: true }),
			],
			600,
		),
	).toBeUndefined();
});
