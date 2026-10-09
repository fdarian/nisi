import { expect, test } from "bun:test";
import { isScannable, scanDeclarations } from "./symbols";

const byName = (files: Parameters<typeof scanDeclarations>[0]) =>
	Object.fromEntries(
		scanDeclarations(files).map((symbol) => [
			symbol.name,
			`${symbol.path}:${symbol.line}`,
		]),
	);

test("TS and JS: functions, classes, consts, types, interfaces and enums, exported or not", () => {
	const found = byName([
		{
			path: "a.ts",
			content: [
				"import x from 'y';",
				"export function useThing() {}",
				"export async function load() {}",
				"export default class Store {}",
				"export const MAX = 3;",
				"let counter = 0;",
				"type Local = string;",
				"export interface Shape {}",
				"export enum Mode { A }",
				"declare function ambient(): void;",
				"export abstract class Base {}",
			].join("\n"),
		},
	]);
	expect(found).toEqual({
		useThing: "a.ts:2",
		load: "a.ts:3",
		Store: "a.ts:4",
		MAX: "a.ts:5",
		counter: "a.ts:6",
		Local: "a.ts:7",
		Shape: "a.ts:8",
		Mode: "a.ts:9",
		ambient: "a.ts:10",
		Base: "a.ts:11",
	});
});

test("indented declarations are locals and are skipped", () => {
	expect(
		byName([
			{
				path: "a.ts",
				content:
					"function outer() {\n\tconst inner = 1;\n\tfunction nested() {}\n}",
			},
		]),
	).toEqual({ outer: "a.ts:1" });
});

test("a name declared twice, in one file or two, is ambiguous and dropped", () => {
	expect(
		byName([
			{
				path: "a.ts",
				content: "export const dup = 1;\nexport const only = 1;",
			},
			{ path: "b.ts", content: "export function dup() {}" },
		]),
	).toEqual({ only: "a.ts:2" });
});

test("Rust, Go and Python forms", () => {
	expect(
		byName([
			{
				path: "a.rs",
				content:
					"pub fn run() {}\npub(crate) struct Config;\nenum Kind {}\nimpl Config {\n    fn hidden() {}\n}",
			},
			{
				path: "b.go",
				content:
					"func Serve() {}\nfunc (s *Server) Close() {}\ntype Handler struct{}\nconst Limit = 3",
			},
			{
				path: "c.py",
				content:
					"def parse():\n    pass\nasync def fetch():\n    pass\nclass Parser:\n    pass\nTIMEOUT = 3\nif x == 1:\n    pass",
			},
		]),
	).toEqual({
		run: "a.rs:1",
		Config: "a.rs:2",
		Kind: "a.rs:3",
		Serve: "b.go:1",
		Close: "b.go:2",
		Handler: "b.go:3",
		Limit: "b.go:4",
		parse: "c.py:1",
		fetch: "c.py:3",
		Parser: "c.py:5",
		TIMEOUT: "c.py:7",
	});
});

test("files in other languages are ignored", () => {
	expect(isScannable("README.md")).toBe(false);
	expect(isScannable("src/a.tsx")).toBe(true);
	expect(byName([{ path: "x.md", content: "const a = 1" }])).toEqual({});
});

test("each declaration carries the name's exact character span in its line", () => {
	const [symbol] = scanDeclarations([
		{ path: "a.ts", content: "\nexport async function loadTodos() {}" },
	]);
	expect(symbol).toMatchObject({
		name: "loadTodos",
		line: 2,
		charStart: 22,
		charEnd: 31,
	});
});
