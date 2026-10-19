import type {
	MemoryStats,
	MilestoneStats,
	SoakStats,
	Stats,
} from "./aggregate.ts";
import type { MemoryRole } from "./memory.ts";
import { formatPhaseTable } from "./soak.ts";

const roleLabels: Record<MemoryRole, string> = {
	main: "main",
	renderer: "renderer(s)",
	gpu: "GPU",
	helper: "other helpers",
	sidecar: "sidecar",
};

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

function table(header: string[], rows: string[][], labelColumns = 1): string[] {
	const widths = header.map((title, index) =>
		Math.max(title.length, ...rows.map((row) => (row[index] as string).length)),
	);
	const line = (row: string[]) =>
		row
			.map((cell, index) =>
				index < labelColumns
					? cell.padEnd(widths[index] as number)
					: cell.padStart(widths[index] as number),
			)
			.join("  ");
	return [line(header), ...rows.map(line)];
}

const statCells = (value: Stats, format: (n: number) => string) => [
	format(value.median),
	format(value.min),
	format(value.max),
	String(value.n),
];

const ms = (value: number) => value.toFixed(1);

export function formatMilestoneStats(rows: readonly MilestoneStats[]): string {
	return [
		"Milestones across runs (ms from the timeline origin)",
		...table(
			["milestone", "median", "min", "max", "n"],
			rows.map((row) => [
				row.name,
				...(!row.applicable
					? ["N/A (deep-link flow)", "", "", ""]
					: row.offsetMs === undefined
						? ["not observed", "", "", "0"]
						: statCells(row.offsetMs, ms)),
			]),
		),
	].join("\n");
}

export function formatMemoryStats(memory: MemoryStats): string {
	const rows = [
		...memory.groups.map((group) => [
			roleLabels[group.role],
			...statCells(group.footprintBytes, mib),
		]),
		["total (with sidecar)", ...statCells(memory.withSidecar, mib)],
		["total (without sidecar)", ...statCells(memory.withoutSidecar, mib)],
	];
	return [
		"Memory across runs — physical footprint in MiB",
		...table(["group", "median", "min", "max", "n"], rows),
	].join("\n");
}

export function formatSoakStats(soak: SoakStats): string {
	const whole = [
		["average", soak.averageBytes],
		["peak", soak.peakBytes],
		["final", soak.finalBytes],
	] as const;
	return [
		"Soak memory across runs — per-phase medians, physical footprint in MiB",
		"total = everything but the sidecar; rend = renderer group; sc = sidecar",
		...formatPhaseTable(soak.phases),
		...(soak.phases.some((phase) => phase.runs < soak.durationMs.n)
			? ["Some phases were reached by fewer runs than the whole-run figures."]
			: []),
		"",
		"Whole run (time-weighted over the samples) — footprint in MiB",
		...table(
			["", "median", "min", "max", "n"],
			[
				...whole.map(([label, value]) => [
					`${label} (without sidecar)`,
					...statCells(value, mib),
				]),
				...soak.groupAverageBytes.map((group) => [
					`average ${roleLabels[group.role]}`,
					...statCells(group.averageBytes, mib),
				]),
			],
		),
	].join("\n");
}
