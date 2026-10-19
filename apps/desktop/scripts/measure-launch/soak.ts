import { type MemoryRole, type MemorySummary, memoryRoles } from "./memory.ts";

export const soakPhases = [
	"open",
	"idle-1",
	"scroll-1",
	"extra-tabs",
	"after-close",
] as const;
export type SoakPhase = (typeof soakPhases)[number];

type Totals = MemorySummary["withSidecar"];

export type SoakSample = {
	/** Epoch milliseconds. */
	at: number;
	/** Milliseconds since the run started. */
	elapsedMs: number;
	phase: SoakPhase;
	groups: MemorySummary["groups"];
	withSidecar: Totals;
	withoutSidecar: Totals;
};

export type SoakPhaseSpan = {
	phase: SoakPhase;
	startedAt: number;
	endedAt: number;
};

export type SoakSeries = {
	samples: SoakSample[];
	phases: SoakPhaseSpan[];
	/** Samples dropped after the first success because a process exited mid-read. */
	skippedSamples: number;
};

export function toSoakSample(
	summary: MemorySummary,
	phase: SoakPhase,
	at: number,
	startedAt: number,
): SoakSample {
	return {
		at,
		elapsedMs: at - startedAt,
		phase,
		groups: summary.groups,
		withSidecar: summary.withSidecar,
		withoutSidecar: summary.withoutSidecar,
	};
}

const group = (sample: SoakSample, role: MemoryRole) => {
	const found = sample.groups.find((entry) => entry.role === role);
	if (found === undefined) throw new Error(`Sample has no ${role} group`);
	return found;
};

export type SoakPhaseSummary = {
	phase: SoakPhase;
	samples: number;
	durationMs: number;
	/** Physical footprint of everything but the sidecar. */
	total: { start: number; peak: number; end: number };
	renderer: { peak: number; end: number };
	sidecar: { start: number; peak: number; end: number };
};

/** One row per phase that has at least one sample, in scenario order. */
export function summarizePhases(series: SoakSeries): SoakPhaseSummary[] {
	return soakPhases.flatMap((phase) => {
		const samples = series.samples.filter((sample) => sample.phase === phase);
		const first = samples[0];
		const last = samples.at(-1);
		if (first === undefined || last === undefined) return [];
		const span = series.phases.find((entry) => entry.phase === phase);
		const footprint = (entry: SoakSample) =>
			entry.withoutSidecar.footprintBytes;
		const renderer = (entry: SoakSample) =>
			group(entry, "renderer").footprintBytes;
		const sidecar = (entry: SoakSample) =>
			group(entry, "sidecar").footprintBytes;
		return [
			{
				phase,
				samples: samples.length,
				durationMs:
					span === undefined
						? last.at - first.at
						: span.endedAt - span.startedAt,
				total: {
					start: footprint(first),
					peak: Math.max(...samples.map(footprint)),
					end: footprint(last),
				},
				renderer: {
					peak: Math.max(...samples.map(renderer)),
					end: renderer(last),
				},
				sidecar: {
					start: sidecar(first),
					peak: Math.max(...samples.map(sidecar)),
					end: sidecar(last),
				},
			},
		];
	});
}

const mib = (bytes: number) => (bytes / 1024 / 1024).toFixed(0);

export function formatPhaseTable(rows: readonly SoakPhaseSummary[]): string[] {
	const header = [
		"phase",
		"samples",
		"dur s",
		"total start",
		"total peak",
		"total end",
		"rend peak",
		"rend end",
		"sc start",
		"sc peak",
		"sc end",
	];
	const cells = rows.map((entry) => [
		entry.phase,
		String(entry.samples),
		(entry.durationMs / 1000).toFixed(0),
		mib(entry.total.start),
		mib(entry.total.peak),
		mib(entry.total.end),
		mib(entry.renderer.peak),
		mib(entry.renderer.end),
		mib(entry.sidecar.start),
		mib(entry.sidecar.peak),
		mib(entry.sidecar.end),
	]);
	const widths = header.map((title, index) =>
		Math.max(
			title.length,
			...cells.map((row) => (row[index] as string).length),
		),
	);
	const line = (row: string[]) =>
		row
			.map((cell, index) =>
				index === 0
					? cell.padEnd(widths[index] as number)
					: cell.padStart(widths[index] as number),
			)
			.join("  ");
	return [line(header), ...cells.map(line)];
}

export function formatSoak(series: SoakSeries, intervalMs: number): string {
	return [
		`Soak memory — physical footprint in MiB, ${series.samples.length} samples every ${(intervalMs / 1000).toFixed(1)}s${series.skippedSamples > 0 ? `, ${series.skippedSamples} skipped (a process exited mid-read)` : ""}`,
		"total = everything but the sidecar; rend = renderer group; sc = sidecar",
		...formatPhaseTable(summarizePhases(series)),
	].join("\n");
}

const csvColumns = (role: MemoryRole) => [
	`${role}_procs`,
	`${role}_rss_bytes`,
	`${role}_footprint_bytes`,
];

export function soakCsv(samples: readonly SoakSample[]): string {
	const header = [
		"timestamp",
		"elapsed_ms",
		"phase",
		...memoryRoles.flatMap(csvColumns),
		"total_rss_bytes",
		"total_footprint_bytes",
		"total_no_sidecar_rss_bytes",
		"total_no_sidecar_footprint_bytes",
	];
	const rows = samples.map((sample) =>
		[
			new Date(sample.at).toISOString(),
			sample.elapsedMs,
			sample.phase,
			...memoryRoles.flatMap((role) => {
				const entry = group(sample, role);
				return [entry.count, entry.rssBytes, entry.footprintBytes];
			}),
			sample.withSidecar.rssBytes,
			sample.withSidecar.footprintBytes,
			sample.withoutSidecar.rssBytes,
			sample.withoutSidecar.footprintBytes,
		].join(","),
	);
	return `${[header.join(","), ...rows].join("\n")}\n`;
}
