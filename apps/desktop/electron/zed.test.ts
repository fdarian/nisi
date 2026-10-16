import { describe, expect, test } from "bun:test";
import { resolveOnPath, zedArgs } from "./zed";

describe("zedArgs", () => {
	test("skips the duplicate when path is the repo root", () => {
		expect(zedArgs("/r", "/r")).toEqual(["/r"]);
	});

	test("passes repo root then path otherwise", () => {
		expect(zedArgs("/r", "/r/a.ts")).toEqual(["/r", "/r/a.ts"]);
	});
});

describe("resolveOnPath", () => {
	test("finds an executable on PATH and ignores missing ones", () => {
		expect(resolveOnPath("sh", "/nonexistent:/bin")).toBe("/bin/sh");
		expect(resolveOnPath("definitely-not-a-binary", "/bin")).toBeUndefined();
		expect(resolveOnPath("sh", undefined)).toBeUndefined();
	});
});
