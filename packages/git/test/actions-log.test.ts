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
	test("trailing lines stamped after a step's whole-second end stay in that step", () => {
		const adjacent = [
			{ number: 1, started_at: iso(1), completed_at: iso(4) },
			{ number: 2, started_at: iso(4), completed_at: iso(10) },
		];
		const raw = [
			`${iso(2).replace(".000Z", ".100Z")} building`,
			`${iso(4).replace(".000Z", ".400Z")} ##[error]Process completed with exit code 1.`,
			`${iso(5).replace(".000Z", ".200Z")} next step`,
		].join("\n");
		const parsed = parseActionsLog(raw, adjacent);
		expect(
			parsed.map((step) =>
				flattenActionsLog(step.nodes).map((line) => line.text),
			),
		).toEqual([
			["building", "Process completed with exit code 1."],
			["next step"],
		]);
	});
	test("a leading UTF-8 BOM does not drop the first line", () => {
		const parsed = parseActionsLog(
			`\uFEFF${iso(2)} first\n${iso(3)} second`,
			windows,
		);
		const first = parsed[0];
		if (first === undefined) throw new Error("Missing parsed step");
		expect(flattenActionsLog(first.nodes).map((line) => line.text)).toEqual([
			"first",
			"second",
		]);
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
		const first = parsed[0];
		if (first === undefined) throw new Error("Missing parsed step");
		expect(flattenActionsLog(first.nodes).map((line) => line.kind)).toEqual([
			"warning",
			"notice",
			"debug",
			"command",
		]);
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
			copied.split("\n").filter((line) => line.endsWith("ERROR failed")),
		).toHaveLength(2);
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
	test("copy strips terminal hyperlinks and handles short failed steps", () => {
		const link = "\u001b]8;;https://example.com\u001b\\error ×\u001b]8;;\u0007";
		const copied = copyActionsErrors([
			{
				name: "test",
				conclusion: "failure",
				nodes: [
					{
						type: "line",
						timestamp: Date.parse(iso(0)),
						kind: "plain",
						text: link,
					},
				],
			},
		]);
		expect(copied).toBe(`test\n${iso(0)} error ×`);
	});
	test("steps without timestamp windows and unfinished steps", () => {
		const parsed = parseActionsLog(`${iso(0)} preamble\n${iso(8)} output`, [
			{ number: 1, started_at: null, completed_at: null },
			{ number: 2, started_at: iso(6), completed_at: null },
		]);
		expect(
			parsed.map((step) =>
				flattenActionsLog(step.nodes).map((line) => line.text),
			),
		).toEqual([["preamble"], ["output"]]);
	});
});
