import { expect, test } from "bun:test";
import { formatTimeline, formatVisibility } from "./format.ts";

test("sorts wall clocks, identifies warm boot and prints waterfall durations", () => {
	const result = formatTimeline([
		{ at: 100, source: "cli", name: "cli.process-start" },
		{
			at: 130,
			source: "sidecar",
			name: "spawn",
			command: "gh",
			args: ["pr", "view"],
			durationMs: 20,
		},
		{ at: 50, source: "sidecar", name: "sidecar.router.ready" },
		{ at: 160, source: "frontend", name: "tab.content.painted", tab: "files" },
		{ at: 161, source: "frontend", name: "trace.done" },
	]);
	expect(result).toContain("sidecar.router.ready: -50.0 ms (warm)");
	expect(result).toContain("tab.content.painted: 60.0 ms");
	expect(result).toContain('20.0 gh ["pr","view"]');
	const timeline = result.slice(0, result.indexOf("Milestones"));
	expect(timeline).not.toContain("spawn");
	expect(timeline).toContain("60.0 frontend tab.content.painted");
	expect(result).toEndWith("Complete");
});

test("keeps subprocesses and RPCs out of the state timeline and omits diagnostic self-noise", () => {
	const marks = [
		{ at: 100, source: "cli" as const, name: "cli.process-start" },
		{ at: 105, source: "sidecar" as const, name: "spawn.start", command: "gh" },
		{
			at: 105,
			source: "sidecar" as const,
			name: "spawn",
			command: "gh",
			durationMs: 2,
		},
		{
			at: 107,
			source: "sidecar" as const,
			name: "rpc.start",
			path: "/api/diagnostics/launchMarks",
			rpcId: "noise",
		},
		{
			at: 107,
			source: "sidecar" as const,
			name: "rpc",
			path: "/api/diagnostics/launchMarks",
			rpcId: "noise",
			durationMs: 1,
		},
		{ at: 110, source: "frontend" as const, name: "files.list.painted" },
		{ at: 120, source: "frontend" as const, name: "files.first-diff.painted" },
		...Array.from({ length: 20 }, (_, index) => ({
			at: 110,
			source: "sidecar" as const,
			name: "rpc",
			path: `/api/call-${index + 1}`,
			durationMs: index + 1,
		})),
	];
	const result = formatTimeline(marks);
	const timeline = result.slice(0, result.indexOf("Milestones"));
	expect(timeline).not.toContain("spawn");
	expect(timeline).not.toContain("rpc");
	expect(result).not.toContain("/api/diagnostics/launchMarks");
	expect(result).toContain("files.list.painted: 10.0 ms");
	expect(result).toContain("files.first-diff.painted: 20.0 ms");
	const slowest = result.slice(
		result.indexOf("Slowest first\n") + "Slowest first\n".length,
		result.indexOf("\n\nINCOMPLETE"),
	);
	expect(slowest.split("\n")).toHaveLength(15);
	expect(slowest).toContain("/api/call-20");
	expect(slowest).not.toContain("/api/call-5 ");
});

test("does not invent an origin or claim incomplete traces succeeded", () => {
	expect(formatTimeline([])).toContain("Missing cli.process-start");
	expect(
		formatTimeline([{ at: 1, source: "cli", name: "cli.process-start" }]),
	).toContain("INCOMPLETE");
});

test("reports every hidden interval up to terminal paint, sorting and deduplicating state", () => {
	const result = formatTimeline(
		[
			{ at: 100, source: "cli", name: "cli.process-start" },
			{ at: 120, source: "frontend", name: "open-requested.received" },
			{
				at: 190,
				source: "frontend",
				name: "frontend.visibility",
				hidden: false,
			},
			{
				at: 130,
				source: "frontend",
				name: "frontend.visibility",
				hidden: true,
			},
			{
				at: 140,
				source: "frontend",
				name: "frontend.visibility",
				hidden: true,
			},
			{
				at: 210,
				source: "frontend",
				name: "frontend.visibility",
				hidden: true,
			},
			{
				at: 230,
				source: "frontend",
				name: "frontend.visibility",
				hidden: false,
			},
			{ at: 250, source: "frontend", name: "tab.content.painted" },
			{ at: 251, source: "frontend", name: "trace.done" },
			{
				at: 260,
				source: "frontend",
				name: "frontend.visibility",
				hidden: true,
			},
		],
		1000,
	);
	expect(result).toContain(
		"window was hidden for 80.0 ms (screen locked / window occluded) — paint timings include that wait",
	);
	expect(result).toContain("30.0 → 90.0 (60.0 ms)");
	expect(result).toContain("110.0 → 130.0 (20.0 ms)");
	expect(result).not.toContain("still hidden at timeout");
	expect(result).toEndWith("Complete");
});

test("extends an unfinished hidden interval to the observation time, not the last event", () => {
	const result = formatTimeline(
		[
			{ at: 100, source: "cli", name: "cli.process-start" },
			{ at: 120, source: "frontend", name: "open-requested.received" },
			{
				at: 121,
				source: "frontend",
				name: "frontend.visibility",
				hidden: true,
			},
			{ at: 130, source: "frontend", name: "open-resolved.received" },
		],
		600,
	);
	expect(result).toContain("window was hidden for 479.0 ms");
	expect(result).toContain("21.0 → 500.0 (479.0 ms) — still hidden at timeout");
	expect(result).toContain("INCOMPLETE");
});

test("clips initial hidden state to traced open and closes it at terminal paint", () => {
	expect(
		formatVisibility(
			[
				{ at: 100, source: "cli", name: "cli.process-start" },
				{
					at: 110,
					source: "frontend",
					name: "frontend.visibility",
					hidden: true,
				},
				{ at: 120, source: "frontend", name: "open-requested.received" },
				{ at: 150, source: "frontend", name: "tab.content.painted" },
			],
			600,
		),
	).toContain("20.0 → 50.0 (30.0 ms) — hidden at terminal mark");
});

test("does not warn for visible, uninstrumented, or out-of-window hidden states", () => {
	const marks = [
		{ at: 100, source: "cli" as const, name: "cli.process-start" },
		{ at: 120, source: "frontend" as const, name: "open-requested.received" },
		{ at: 150, source: "frontend" as const, name: "tab.content.painted" },
	];
	expect(formatVisibility(marks, 600)).toBeUndefined();
	expect(
		formatVisibility(
			[
				...marks,
				{
					at: 105,
					source: "frontend",
					name: "frontend.visibility",
					hidden: true,
				},
				{
					at: 110,
					source: "frontend",
					name: "frontend.visibility",
					hidden: false,
				},
				{
					at: 121,
					source: "frontend",
					name: "frontend.visibility",
					hidden: false,
				},
				{
					at: 130,
					source: "sidecar",
					name: "frontend.visibility",
					hidden: true,
				},
				{
					at: 160,
					source: "frontend",
					name: "frontend.visibility",
					hidden: true,
				},
			],
			600,
		),
	).toBeUndefined();
});
