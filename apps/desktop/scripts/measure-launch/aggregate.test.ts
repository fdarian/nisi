import { expect, test } from "bun:test";
import {
	stats,
	summarizeMemoryRuns,
	summarizeMilestones,
	summarizeSoakRun,
	summarizeSoakRuns,
	timeWeightedAverage,
} from "./aggregate.ts";
import type { Milestone } from "./format.ts";
import {
	type MemoryProcess,
	type MemoryRole,
	summarizeMemory,
} from "./memory.ts";
import {
	formatMemoryStats,
	formatMilestoneStats,
	formatSoakStats,
} from "./runs-report.ts";
import { type SoakPhase, type SoakSeries, toSoakSample } from "./soak.ts";

const MiB = 1024 * 1024;

test("stats take the median of an odd and an even count, with min, max and n", () => {
	expect(stats([30, 10, 20])).toEqual({ median: 20, min: 10, max: 30, n: 3 });
	expect(stats([40, 10, 20, 30])).toEqual({
		median: 25,
		min: 10,
		max: 40,
		n: 4,
	});
	expect(stats([7])).toEqual({ median: 7, min: 7, max: 7, n: 1 });
	expect(() => stats([])).toThrow("zero values");
});

const measured = (name: string, offsetMs: number): Milestone => ({
	name,
	status: "measured",
	offsetMs,
});

test("milestones are summarized across the runs that observed them", () => {
	const summary = summarizeMilestones([
		[
			measured("a", 100),
			{ name: "b", status: "not-observed" },
			{ name: "c", status: "n/a" },
		],
		[
			measured("a", 300),
			{ name: "b", status: "not-observed" },
			{ name: "c", status: "n/a" },
		],
		[
			{ name: "a", status: "not-observed" },
			{ name: "b", status: "not-observed" },
			{ name: "c", status: "n/a" },
		],
	]);
	expect(summary).toEqual([
		{
			name: "a",
			applicable: true,
			offsetMs: { median: 200, min: 100, max: 300, n: 2 },
		},
		{ name: "b", applicable: true, offsetMs: undefined },
		{ name: "c", applicable: false, offsetMs: undefined },
	]);
	const text = formatMilestoneStats(summary);
	expect(text).toContain("median");
	expect(text).toMatch(/a\s+200\.0\s+100\.0\s+300\.0\s+2/);
	expect(text).toContain("not observed");
	expect(text).toContain("N/A (deep-link flow)");
});

test("runs that disagree on the milestone list are rejected", () => {
	expect(() =>
		summarizeMilestones([[measured("a", 1)], [measured("b", 1)]]),
	).toThrow("disagree");
});

function memory(footprintMiB: Partial<Record<MemoryRole, number>>) {
	const processes: MemoryProcess[] = Object.entries(footprintMiB).map(
		([role, value], index) => ({
			pid: index + 1,
			role: role as MemoryRole,
			name: role,
			rssBytes: (value as number) * 2 * MiB,
			footprintBytes: (value as number) * MiB,
		}),
	);
	return summarizeMemory(0, processes);
}

test("memory footprint is summarized per group and in total", () => {
	const summary = summarizeMemoryRuns([
		memory({ main: 50, renderer: 200, sidecar: 40 }),
		memory({ main: 60, renderer: 300, sidecar: 50 }),
		memory({ main: 70, renderer: 400, sidecar: 60 }),
	]);
	const footprint = (role: MemoryRole) =>
		summary.groups.find((group) => group.role === role)?.footprintBytes;
	expect(footprint("renderer")).toEqual({
		median: 300 * MiB,
		min: 200 * MiB,
		max: 400 * MiB,
		n: 3,
	});
	expect(footprint("gpu")).toEqual({ median: 0, min: 0, max: 0, n: 3 });
	expect(summary.withSidecar.median).toBe(410 * MiB);
	expect(summary.withoutSidecar).toEqual({
		median: 360 * MiB,
		min: 250 * MiB,
		max: 470 * MiB,
		n: 3,
	});
	const text = formatMemoryStats(summary);
	expect(text).toContain("total (without sidecar)");
	expect(text).toMatch(/renderer\(s\)\s+300\.0\s+200\.0\s+400\.0\s+3/);
});

test("the time-weighted average counts each stretch by its length", () => {
	expect(
		timeWeightedAverage([
			{ at: 0, value: 100 },
			{ at: 1000, value: 100 },
			{ at: 4000, value: 200 },
		]),
	).toBe((100 * 1000 + 150 * 3000) / 4000);
	expect(timeWeightedAverage([{ at: 5, value: 42 }])).toBe(42);
	expect(() => timeWeightedAverage([])).toThrow("zero samples");
});

function series(
	rows: [number, SoakPhase, Partial<Record<MemoryRole, number>>][],
): SoakSeries {
	return {
		samples: rows.map(([elapsedMs, phase, footprint]) =>
			toSoakSample(memory(footprint), phase, 1000 + elapsedMs, 1000),
		),
		phases: [],
		skippedSamples: 0,
	};
}

const runA = series([
	[0, "open", { main: 50, renderer: 100, sidecar: 40 }],
	[2000, "open", { main: 50, renderer: 300, sidecar: 60 }],
	[4000, "idle-1", { main: 50, renderer: 280, sidecar: 55 }],
	[6000, "idle-1", { main: 50, renderer: 500, sidecar: 56 }],
]);
const runB = series([
	[0, "open", { main: 60, renderer: 100, sidecar: 40 }],
	[2000, "open", { main: 60, renderer: 500, sidecar: 60 }],
	[4000, "idle-1", { main: 60, renderer: 480, sidecar: 55 }],
	[6000, "idle-1", { main: 60, renderer: 700, sidecar: 56 }],
]);

test("a soak run is reduced to a time-weighted average, peak and final footprint without the sidecar", () => {
	const totals = summarizeSoakRun(runA);
	expect(totals.durationMs).toBe(6000);
	// totals: 150, 350, 330, 550 MiB, sampled every 2 s
	expect(totals.averageBytes).toBe(((250 + 340 + 440) / 3) * MiB);
	expect(totals.peakBytes).toBe(550 * MiB);
	expect(totals.finalBytes).toBe(550 * MiB);
	const group = (role: MemoryRole) =>
		totals.groupAverageBytes.find((entry) => entry.role === role)?.averageBytes;
	expect(group("main")).toBe(50 * MiB);
	expect(group("sidecar")).toBe(((50 + 57.5 + 55.5) / 3) * MiB);
	expect(group("gpu")).toBe(0);
});

test("soak runs give per-phase medians and whole-run statistics", () => {
	const summary = summarizeSoakRuns([runA, runB]);
	expect(summary.phases.map((phase) => [phase.phase, phase.runs])).toEqual([
		["open", 2],
		["idle-1", 2],
	]);
	const open = summary.phases[0];
	// open total start: 150 and 160; peak: 350 and 560
	expect(open?.total.start).toBe(155 * MiB);
	expect(open?.total.peak).toBe(455 * MiB);
	expect(open?.samples).toBe(2);
	expect(summary.peakBytes).toEqual({
		median: 655 * MiB,
		min: 550 * MiB,
		max: 760 * MiB,
		n: 2,
	});
	expect(summary.finalBytes.max).toBe(760 * MiB);
	const text = formatSoakStats(summary);
	expect(text).toContain("open");
	expect(text).toContain("idle-1");
	expect(text).toContain("average (without sidecar)");
	expect(text).toContain("peak (without sidecar)");
	expect(text).toContain("final (without sidecar)");
	expect(text).toContain("average renderer(s)");
});

test("a run without samples cannot be summarized", () => {
	expect(() =>
		summarizeSoakRun({ samples: [], phases: [], skippedSamples: 0 }),
	).toThrow("no samples");
	expect(() => summarizeSoakRuns([])).toThrow("No runs");
	expect(() => summarizeMemoryRuns([])).toThrow("No runs");
});
