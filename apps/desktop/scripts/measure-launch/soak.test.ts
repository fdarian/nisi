import { expect, test } from "bun:test";
import {
	type MemoryProcess,
	type MemoryRole,
	summarizeMemory,
} from "./memory.ts";
import {
	formatSoak,
	type SoakPhase,
	type SoakSeries,
	soakCsv,
	summarizePhases,
	toSoakSample,
} from "./soak.ts";

const MiB = 1024 * 1024;

function summary(footprintMiB: Partial<Record<MemoryRole, number>>) {
	const processes: MemoryProcess[] = Object.entries(footprintMiB).map(
		([role, value], index) => ({
			pid: index + 1,
			role: role as MemoryRole,
			name: role,
			rssBytes: (value as number) * 2 * MiB,
			footprintBytes: (value as number) * MiB,
		}),
	);
	return summarizeMemory("electron", 0, processes);
}

function sample(
	elapsedMs: number,
	phase: SoakPhase,
	footprintMiB: Partial<Record<MemoryRole, number>>,
) {
	return toSoakSample(summary(footprintMiB), phase, 1000 + elapsedMs, 1000);
}

const series: SoakSeries = {
	samples: [
		sample(0, "open", { main: 50, renderer: 100, sidecar: 40 }),
		sample(2000, "open", { main: 50, renderer: 300, sidecar: 60 }),
		sample(4000, "idle-1", { main: 50, renderer: 280, sidecar: 55 }),
		sample(6000, "scroll-1", { main: 50, renderer: 500, sidecar: 56 }),
		sample(8000, "scroll-1", { main: 55, renderer: 900, sidecar: 58 }),
		sample(10000, "scroll-1", { main: 55, renderer: 700, sidecar: 57 }),
	],
	phases: [
		{ phase: "open", startedAt: 1000, endedAt: 4000 },
		{ phase: "idle-1", startedAt: 4000, endedAt: 6000 },
		{ phase: "scroll-1", startedAt: 6000, endedAt: 11000 },
	],
	skippedSamples: 1,
};

test("a sample keeps per-group and total footprint, without the per-process rows", () => {
	const entry = sample(2000, "open", { main: 50, renderer: 300, sidecar: 60 });
	expect(entry.elapsedMs).toBe(2000);
	expect(entry.phase).toBe("open");
	expect(
		entry.groups.find((group) => group.role === "renderer")?.footprintBytes,
	).toBe(300 * MiB);
	expect(entry.withSidecar.footprintBytes).toBe(410 * MiB);
	expect(entry.withoutSidecar.footprintBytes).toBe(350 * MiB);
	expect("processes" in entry).toBe(false);
});

test("phase summaries report start, peak and end of total-without-sidecar, renderer and sidecar", () => {
	const phases = summarizePhases(series);
	expect(phases.map((phase) => phase.phase)).toEqual([
		"open",
		"idle-1",
		"scroll-1",
	]);
	const scroll = phases[2];
	expect(scroll?.samples).toBe(3);
	expect(scroll?.durationMs).toBe(5000);
	expect(scroll?.total).toEqual({
		start: 550 * MiB,
		peak: 955 * MiB,
		end: 755 * MiB,
	});
	expect(scroll?.renderer).toEqual({ peak: 900 * MiB, end: 700 * MiB });
	expect(scroll?.sidecar).toEqual({
		start: 56 * MiB,
		peak: 58 * MiB,
		end: 57 * MiB,
	});
});

test("a phase without samples is left out of the table", () => {
	const only: SoakSeries = {
		samples: series.samples.slice(0, 2),
		phases: series.phases,
		skippedSamples: 0,
	};
	expect(summarizePhases(only).map((phase) => phase.phase)).toEqual(["open"]);
});

test("the report has one row per phase and says when samples were skipped", () => {
	const lines = formatSoak(series, 2000).split("\n");
	expect(lines[0]).toContain("6 samples every 2.0s, 1 skipped");
	expect(lines.at(-1)).toMatch(
		/^scroll-1\s+3\s+5\s+550\s+955\s+755\s+900\s+700/,
	);
	expect(lines).toHaveLength(2 + 1 + 3);
});

test("the CSV has a header, one row per sample, and every role's columns", () => {
	const lines = soakCsv(series.samples).trimEnd().split("\n");
	expect(lines).toHaveLength(7);
	const header = (lines[0] as string).split(",");
	expect(header.slice(0, 3)).toEqual(["timestamp", "elapsed_ms", "phase"]);
	expect(header).toContain("renderer_footprint_bytes");
	expect(header).toContain("total_no_sidecar_footprint_bytes");
	const row = (lines[2] as string).split(",");
	expect(row).toHaveLength(header.length);
	expect(row[1]).toBe("2000");
	expect(row[2]).toBe("open");
	expect(row[header.indexOf("renderer_footprint_bytes")]).toBe(
		String(300 * MiB),
	);
	expect(row.at(-1)).toBe(String(350 * MiB));
});
