import { expect, test } from "bun:test";
import {
	classifyProcess,
	formatMemory,
	type MemoryProcess,
	parseFootprint,
	parseProcessDetails,
	summarizeMemory,
} from "./memory.ts";
import { type Shell, shells } from "./shell.ts";

const bundle = "/work tree/nisi-electrobun.app";
const electrobun: Shell = { ...shells.electrobun, bundlePath: bundle };
const electron: Shell = {
	...shells.electron,
	bundlePath: "/work tree/nisi.app",
};
const helper = (name: string) =>
	`${bundle}/Contents/Frameworks/bun Helper (${name}).app/Contents/MacOS/bun Helper (${name})`;

test("ps details keep the full args and convert KiB to bytes", () => {
	expect(
		parseProcessDetails(
			[
				` 11 204800 ${bundle}/Contents/MacOS/bun main.js`,
				`13  51200 ${helper("Renderer")} --type=renderer --lang=en-US`,
			].join("\n"),
		),
	).toEqual([
		{
			pid: 11,
			rssBytes: 204800 * 1024,
			args: `${bundle}/Contents/MacOS/bun main.js`,
		},
		{
			pid: 13,
			rssBytes: 51200 * 1024,
			args: `${helper("Renderer")} --type=renderer --lang=en-US`,
		},
	]);
	expect(() => parseProcessDetails("garbage")).toThrow("Invalid ps row");
});

test("footprint output yields phys_footprint bytes, not the formatted header", () => {
	expect(
		parseFootprint(
			[
				"======",
				"bun [11]: 64-bit    Footprint: 138 MB (16384 bytes per page)",
				"======",
				"",
				"Auxiliary data:",
				"    phys_footprint: 144376840 B",
				"    phys_footprint_peak: 158172168 B",
			].join("\n"),
		),
	).toBe(144376840);
	expect(() => parseFootprint("nothing here")).toThrow("no phys_footprint");
});

test("processes are classified by executable, then by --type", () => {
	const classify = (shell: Shell, command: string, args = "") =>
		classifyProcess(shell, command, `${command} ${args}`);
	expect(classify(electrobun, `${bundle}/Contents/MacOS/launcher`)).toBe(
		"main",
	);
	expect(classify(electrobun, `${bundle}/Contents/MacOS/bun`, "main.js")).toBe(
		"main",
	);
	expect(classify(electrobun, `${bundle}/Contents/MacOS/sidecar`)).toBe(
		"sidecar",
	);
	expect(
		classify(electrobun, helper("Renderer"), "--type=renderer --lang=en"),
	).toBe("renderer");
	expect(
		classify(electrobun, helper("GPU"), "--type=gpu-process --use-gl=angle"),
	).toBe("gpu");
	expect(
		classify(
			electrobun,
			helper("Plugin"),
			"--type=utility --utility-sub-type=network.mojom.NetworkService",
		),
	).toBe("helper");
	expect(
		classify(electrobun, `${bundle}/Contents/Frameworks/crashpad_handler`),
	).toBe("helper");
	expect(classify(electron, "/work tree/nisi.app/Contents/MacOS/nisi")).toBe(
		"main",
	);
	expect(classify(electrobun, `${bundle}/Contents/MacOS/nisi-cli`)).toBe(
		"helper",
	);
});

const sample = (
	pid: number,
	role: MemoryProcess["role"],
	rssMiB: number,
	footprintMiB: number,
): MemoryProcess => ({
	pid,
	role,
	name: `p${pid}`,
	rssBytes: rssMiB * 1024 * 1024,
	footprintBytes: footprintMiB * 1024 * 1024,
});

test("totals are reported with and without the sidecar", () => {
	const summary = summarizeMemory("electrobun", 5000, [
		sample(12, "sidecar", 100, 90),
		sample(10, "main", 50, 40),
		sample(13, "renderer", 300, 250),
		sample(14, "gpu", 80, 70),
		sample(15, "renderer", 120, 110),
	]);
	expect(summary.processes.map((entry) => entry.pid)).toEqual([
		10, 12, 13, 14, 15,
	]);
	expect(
		summary.groups.map((group) => [
			group.role,
			group.count,
			group.rssBytes / 1024 / 1024,
		]),
	).toEqual([
		["main", 1, 50],
		["renderer", 2, 420],
		["gpu", 1, 80],
		["helper", 0, 0],
		["sidecar", 1, 100],
	]);
	expect(summary.withSidecar).toEqual({
		count: 5,
		rssBytes: 650 * 1024 * 1024,
		footprintBytes: 560 * 1024 * 1024,
	});
	expect(summary.withoutSidecar).toEqual({
		count: 4,
		rssBytes: 550 * 1024 * 1024,
		footprintBytes: 470 * 1024 * 1024,
	});
	const text = formatMemory(summary);
	expect(text).toContain("renderer(s)");
	expect(text).toContain("total (with sidecar)");
	expect(text).toContain("total (without sidecar)");
	expect(text).toContain("550.0 MiB");
});
