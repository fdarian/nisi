import type { Milestone } from "./format.ts";
import { type MemoryRole, type MemorySummary, memoryRoles } from "./memory.ts";
import {
	type SoakPhaseSummary,
	type SoakSeries,
	soakPhases,
	summarizePhases,
} from "./soak.ts";

export type Stats = { median: number; min: number; max: number; n: number };

export function stats(values: readonly number[]): Stats {
	if (values.length === 0) throw new Error("Cannot summarize zero values");
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return {
		median:
			sorted.length % 2 === 1
				? (sorted[middle] as number)
				: ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2,
		min: sorted[0] as number,
		max: sorted[sorted.length - 1] as number,
		n: sorted.length,
	};
}

export type MilestoneStats = {
	name: string;
	applicable: boolean;
	/** Undefined when no run observed the milestone. */
	offsetMs: Stats | undefined;
};

export function summarizeMilestones(
	runs: readonly (readonly Milestone[])[],
): MilestoneStats[] {
	const first = runs[0];
	if (first === undefined) throw new Error("No runs to summarize");
	return first.map((milestone, index) => {
		const column = runs.map((run) => {
			const entry = run[index];
			if (entry === undefined || entry.name !== milestone.name)
				throw new Error(`Runs disagree on milestone ${milestone.name}`);
			return entry;
		});
		const offsets = column.flatMap((entry) =>
			entry.status === "measured" ? [entry.offsetMs] : [],
		);
		return {
			name: milestone.name,
			applicable: column.some((entry) => entry.status !== "n/a"),
			offsetMs: offsets.length === 0 ? undefined : stats(offsets),
		};
	});
}

export type MemoryStats = {
	groups: { role: MemoryRole; footprintBytes: Stats }[];
	withSidecar: Stats;
	withoutSidecar: Stats;
};

export function summarizeMemoryRuns(
	runs: readonly MemorySummary[],
): MemoryStats {
	if (runs.length === 0) throw new Error("No runs to summarize");
	return {
		groups: memoryRoles.map((role) => ({
			role,
			footprintBytes: stats(
				runs.map((run) => {
					const group = run.groups.find((entry) => entry.role === role);
					if (group === undefined) throw new Error(`Run has no ${role} group`);
					return group.footprintBytes;
				}),
			),
		})),
		withSidecar: stats(runs.map((run) => run.withSidecar.footprintBytes)),
		withoutSidecar: stats(runs.map((run) => run.withoutSidecar.footprintBytes)),
	};
}

/**
 * Trapezoidal mean over the sampled interval, so a sample that stands for a long
 * gap (a skipped read) counts for as much time as it covers.
 */
export function timeWeightedAverage(
	points: readonly { at: number; value: number }[],
): number {
	const first = points[0];
	const last = points.at(-1);
	if (first === undefined || last === undefined)
		throw new Error("Cannot average zero samples");
	const duration = last.at - first.at;
	if (duration === 0) return first.value;
	let area = 0;
	for (let index = 1; index < points.length; index += 1) {
		const previous = points[index - 1] as (typeof points)[number];
		const current = points[index] as (typeof points)[number];
		area += ((previous.value + current.value) / 2) * (current.at - previous.at);
	}
	return area / duration;
}

export type SoakRunTotals = {
	durationMs: number;
	/** Footprint of everything but the sidecar. */
	averageBytes: number;
	peakBytes: number;
	finalBytes: number;
	groupAverageBytes: { role: MemoryRole; averageBytes: number }[];
};

export function summarizeSoakRun(series: SoakSeries): SoakRunTotals {
	const first = series.samples[0];
	const last = series.samples.at(-1);
	if (first === undefined || last === undefined)
		throw new Error("Soak run has no samples");
	const total = series.samples.map((sample) => ({
		at: sample.at,
		value: sample.withoutSidecar.footprintBytes,
	}));
	return {
		durationMs: last.at - first.at,
		averageBytes: timeWeightedAverage(total),
		peakBytes: Math.max(...total.map((point) => point.value)),
		finalBytes: last.withoutSidecar.footprintBytes,
		groupAverageBytes: memoryRoles.map((role) => ({
			role,
			averageBytes: timeWeightedAverage(
				series.samples.map((sample) => {
					const group = sample.groups.find((entry) => entry.role === role);
					if (group === undefined)
						throw new Error(`Sample has no ${role} group`);
					return { at: sample.at, value: group.footprintBytes };
				}),
			),
		})),
	};
}

export type SoakStats = {
	/** Per-phase medians across the runs that reached the phase. */
	phases: (SoakPhaseSummary & { runs: number })[];
	durationMs: Stats;
	averageBytes: Stats;
	peakBytes: Stats;
	finalBytes: Stats;
	groupAverageBytes: { role: MemoryRole; averageBytes: Stats }[];
};

export function summarizeSoakRuns(runs: readonly SoakSeries[]): SoakStats {
	if (runs.length === 0) throw new Error("No runs to summarize");
	const perRun = runs.map((series) => ({
		phases: summarizePhases(series),
		totals: summarizeSoakRun(series),
	}));
	const median = (values: readonly number[]) => stats(values).median;
	return {
		phases: soakPhases.flatMap((phase) => {
			const rows = perRun.flatMap((run) =>
				run.phases.filter((entry) => entry.phase === phase),
			);
			if (rows.length === 0) return [];
			return [
				{
					phase,
					runs: rows.length,
					samples: Math.round(median(rows.map((row) => row.samples))),
					durationMs: median(rows.map((row) => row.durationMs)),
					total: {
						start: median(rows.map((row) => row.total.start)),
						peak: median(rows.map((row) => row.total.peak)),
						end: median(rows.map((row) => row.total.end)),
					},
					renderer: {
						peak: median(rows.map((row) => row.renderer.peak)),
						end: median(rows.map((row) => row.renderer.end)),
					},
					sidecar: {
						start: median(rows.map((row) => row.sidecar.start)),
						peak: median(rows.map((row) => row.sidecar.peak)),
						end: median(rows.map((row) => row.sidecar.end)),
					},
				},
			];
		}),
		durationMs: stats(perRun.map((run) => run.totals.durationMs)),
		averageBytes: stats(perRun.map((run) => run.totals.averageBytes)),
		peakBytes: stats(perRun.map((run) => run.totals.peakBytes)),
		finalBytes: stats(perRun.map((run) => run.totals.finalBytes)),
		groupAverageBytes: memoryRoles.map((role) => ({
			role,
			averageBytes: stats(
				perRun.map((run) => {
					const group = run.totals.groupAverageBytes.find(
						(entry) => entry.role === role,
					);
					if (group === undefined) throw new Error(`Run has no ${role} group`);
					return group.averageBytes;
				}),
			),
		})),
	};
}
