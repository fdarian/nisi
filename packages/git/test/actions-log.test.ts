import { describe, expect, test } from "bun:test";
import {
	copyActionsErrors,
	flattenActionsLog,
	parseActionsLog,
} from "../src/github/actions-log.ts";
import { actionsJobIdFromUrl } from "../src/github/gh/checks.ts";

const iso = (seconds: number) =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
const windows = [
	{ number: 1, started_at: iso(1), completed_at: iso(4) },
	{ number: 2, started_at: iso(6), completed_at: iso(10) },
];

describe("Actions logs", () => {
	test("extracts only Actions job URLs", () => {
		expect(
			actionsJobIdFromUrl("https://github.com/o/r/actions/runs/12/job/34?pr=1"),
		).toBe(34);
		for (const url of [
			"https://example.com/o/r/actions/runs/12/job/34",
			"https://github.com/o/r/actions/runs/12",
			"https://github.com/o/r/checks/34",
			"https://github.com/o/r/actions/runs/12/job/0",
		])
			expect(actionsJobIdFromUrl(url)).toBeUndefined();
	});
	test("assigns preamble, windows, gaps and trailing output without losing ANSI", () => {
		const raw = [0, 2, 5, 6, 10, 11]
			.map(
				(n) =>
					`${iso(n)} ${n === 6 ? "##[error]" : ""}\u001b[31mline ${n}\u001b[0m`,
			)
			.join("\n");
		const parsed = parseActionsLog(raw, windows);
		expect(parsed.map((step) => flattenActionsLog(step.nodes).length)).toEqual([
			3, 3,
		]);
		expect(parsed[1]?.nodes[0]).toEqual({
			type: "line",
			timestamp: Date.parse(iso(6)),
			kind: "error",
			text: "\u001b[31mline 6\u001b[0m",
		});
	});
	test("nested and unbalanced groups, all annotation kinds", () => {
		const texts = [
			"##[endgroup]",
			"##[group]outer",
			"##[group]inner",
			"##[warning]warn",
			"##[endgroup]",
			"##[notice]note",
			"##[debug]debug",
			"##[command]run",
		];
		const parsed = parseActionsLog(
			texts.map((text) => `${iso(2)} ${text}`).join("\n"),
			windows,
		);
		const outer = parsed[0]?.nodes[0];
		expect(outer).toMatchObject({ type: "group", title: "outer" });
		if (outer?.type !== "group") throw new Error("Missing outer group");
		expect(outer.children[0]).toMatchObject({ type: "group", title: "inner" });
		expect(
			flattenActionsLog(parsed[0]?.nodes ?? []).map((line) => line.kind),
		).toEqual(["warning", "notice", "debug", "command"]);
	});
	test("empty logs, no steps and malformed timestamps", () => {
		expect(parseActionsLog("", windows).map((step) => step.nodes)).toEqual([
			[],
			[],
		]);
		expect(parseActionsLog(`${iso(2)} hello`, [])).toEqual([]);
		expect(
			parseActionsLog("bad line\nnot a timestamp", windows)[0]?.nodes,
		).toEqual([]);
	});
	test("copy errors merges context windows, keeps tail, reports gaps, strips ANSI", () => {
		const nodes = Array.from({ length: 100 }, (_unused, index) => ({
			type: "line" as const,
			timestamp: Date.parse(iso(index)),
			text:
				index === 20 || index === 24
					? "\u001b[31mERROR failed\u001b[0m"
					: `line ${index}`,
			kind: "plain" as const,
		}));
		const copied = copyActionsErrors([
			{ name: "test", conclusion: "failure", nodes },
			{ name: "ok", conclusion: "success", nodes },
		]);
		expect(copied.startsWith("test\n  … 12 log entries omitted …\n")).toBe(
			true,
		);
		expect(copied).toContain("  … 47 log entries omitted …");
		expect(copied).toContain(`${iso(20)} ERROR failed`);
		expect(copied).toContain(`${iso(99)} line 99`);
		expect(copied).not.toContain("\u001b");
		expect(copied).not.toContain("ok");
		expect(
			copied.split("\n").filter((line) => line.includes("line 24")),
		).toHaveLength(0);
	});
	test("copy explicit error and symbol matches inside groups, tail without errors", () => {
		const parsed = parseActionsLog(
			Array.from(
				{ length: 40 },
				(_unused, n) =>
					`${iso(n)} ${n === 0 ? "##[group]build" : n === 1 ? "##[error]exit 1" : n === 4 ? "✖ boom" : `line ${n}`}`,
			).join("\n"),
			[{ number: 1, started_at: iso(0), completed_at: iso(40) }],
		);
		const nodes = parsed[0]?.nodes;
		if (nodes === undefined) throw new Error("Missing parsed step");
		expect(
			copyActionsErrors([{ name: "build", conclusion: "failure", nodes }]),
		).toContain(`${iso(1)} exit 1`);
		expect(
			copyActionsErrors([
				{
					name: "build",
					conclusion: "failure",
					nodes: flattenActionsLog(nodes).slice(15),
				},
			]),
		).toContain("  … 4 log entries omitted …");
		expect(copyActionsErrors([])).toBe("");
	});
});
