import { basename } from "node:path";
import { Effect } from "effect";
import { bundleRows, processTable } from "./processes.ts";
import type { Shell } from "./shell.ts";

export const memoryRoles = [
	"main",
	"renderer",
	"gpu",
	"helper",
	"sidecar",
] as const;
export type MemoryRole = (typeof memoryRoles)[number];

const roleLabels: Record<MemoryRole, string> = {
	main: "shell main",
	renderer: "renderer(s)",
	gpu: "GPU",
	helper: "other helpers",
	sidecar: "sidecar",
};

export type MemoryProcess = {
	pid: number;
	role: MemoryRole;
	name: string;
	rssBytes: number;
	footprintBytes: number;
};

type Totals = { count: number; rssBytes: number; footprintBytes: number };

export type MemorySummary = {
	shell: string;
	settleMs: number;
	processes: MemoryProcess[];
	groups: (Totals & { role: MemoryRole })[];
	withSidecar: Totals;
	withoutSidecar: Totals;
};

/** Parses `ps -p … -o pid=,rss=,args=`; RSS is in KiB. */
export function parseProcessDetails(
	output: string,
): { pid: number; rssBytes: number; args: string }[] {
	return output
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
			if (match === null) throw new Error(`Invalid ps row: ${line}`);
			return {
				pid: Number(match[1]),
				rssBytes: Number(match[2]) * 1024,
				args: match[3] as string,
			};
		});
}

/** Reads `phys_footprint` from `footprint -p <pid> --noCategories -f bytes`. */
export function parseFootprint(output: string): number {
	const match = output.match(/^\s*phys_footprint:\s*(\d+) B\s*$/m);
	if (match === null)
		throw new Error(`footprint output has no phys_footprint:\n${output}`);
	return Number(match[1]);
}

export function classifyProcess(
	shell: Shell,
	command: string,
	args: string,
): MemoryRole {
	const inBundle = (relative: string) =>
		command === `${shell.bundlePath}/${relative}`;
	if (inBundle(shell.sidecarExecutable)) return "sidecar";
	if (shell.mainExecutables.some(inBundle)) return "main";
	const type = args.match(/(?:^|\s)--type=(\S+)/)?.[1];
	if (type === "renderer") return "renderer";
	if (type === "gpu-process") return "gpu";
	return "helper";
}

const sum = (processes: readonly MemoryProcess[]): Totals => ({
	count: processes.length,
	rssBytes: processes.reduce((total, entry) => total + entry.rssBytes, 0),
	footprintBytes: processes.reduce(
		(total, entry) => total + entry.footprintBytes,
		0,
	),
});

export function summarizeMemory(
	shell: string,
	settleMs: number,
	processes: readonly MemoryProcess[],
): MemorySummary {
	return {
		shell,
		settleMs,
		processes: [...processes].sort((a, b) => a.pid - b.pid),
		groups: memoryRoles.map((role) => {
			const members = processes.filter((entry) => entry.role === role);
			return { role, ...sum(members) };
		}),
		withSidecar: sum(processes),
		withoutSidecar: sum(processes.filter((entry) => entry.role !== "sidecar")),
	};
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

export function formatMemory(summary: MemorySummary): string {
	type Row = { label: string; count?: number; totals: Omit<Totals, "count"> };
	const rows: Row[] = [];
	for (const group of summary.groups) {
		rows.push({
			label: roleLabels[group.role],
			count: group.count,
			totals: group,
		});
		for (const entry of summary.processes.filter(
			(candidate) => candidate.role === group.role,
		))
			rows.push({ label: `  ${entry.name} [${entry.pid}]`, totals: entry });
	}
	rows.push(
		{
			label: "total (with sidecar)",
			count: summary.withSidecar.count,
			totals: summary.withSidecar,
		},
		{
			label: "total (without sidecar)",
			count: summary.withoutSidecar.count,
			totals: summary.withoutSidecar,
		},
	);
	const width = Math.max(...rows.map((row) => row.label.length)) + 2;
	const line = (label: string, count: string, rss: string, footprint: string) =>
		`${label.padEnd(width)}${count.padStart(5)}${rss.padStart(14)}${footprint.padStart(16)}`;
	return [
		`Memory — ${summary.shell}, sampled ${(summary.settleMs / 1000).toFixed(1)}s after trace.done`,
		line("", "procs", "RSS", "footprint"),
		...rows.map((row) =>
			line(
				row.label,
				row.count === undefined ? "" : String(row.count),
				mib(row.totals.rssBytes),
				mib(row.totals.footprintBytes),
			),
		),
	].join("\n");
}

const sampleOne = (
	shell: Shell,
	row: { pid: number; command: string },
	detail: { rssBytes: number; args: string },
) =>
	Effect.gen(function* () {
		const result = yield* Effect.tryPromise(() =>
			Bun.$`footprint -p ${row.pid} --noCategories -f bytes`.nothrow().quiet(),
		);
		if (result.exitCode !== 0)
			return yield* Effect.fail(
				new Error(
					`footprint -p ${row.pid} failed: ${result.stderr.toString() || result.stdout.toString()}`,
				),
			);
		return {
			pid: row.pid,
			role: classifyProcess(shell, row.command, detail.args),
			name: basename(row.command),
			rssBytes: detail.rssBytes,
			footprintBytes: yield* Effect.try(() =>
				parseFootprint(result.stdout.toString()),
			),
		} satisfies MemoryProcess;
	});

export const sampleMemory = (shell: Shell, settleMs: number) =>
	Effect.gen(function* () {
		yield* Effect.sleep(`${settleMs} millis`);
		const rows = yield* processTable.pipe(
			Effect.flatMap((output) => Effect.try(() => bundleRows(output, shell))),
		);
		if (rows.length === 0)
			return yield* Effect.fail(
				new Error(`No running processes under ${shell.bundlePath}/Contents`),
			);
		const pids = rows.map((row) => row.pid).join(",");
		const details = yield* Effect.tryPromise(() =>
			Bun.$`ps -p ${pids} -o pid=,rss=,args=`.text(),
		).pipe(
			Effect.flatMap((output) => Effect.try(() => parseProcessDetails(output))),
		);
		const processes = yield* Effect.forEach(
			rows,
			(row) => {
				const detail = details.find((entry) => entry.pid === row.pid);
				if (detail === undefined)
					return Effect.fail(
						new Error(
							`Process ${row.pid} (${row.command}) exited during sampling`,
						),
					);
				return sampleOne(shell, row, detail);
			},
			{ concurrency: "unbounded" },
		);
		return summarizeMemory(shell.name, settleMs, processes);
	});
