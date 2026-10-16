import { describe, expect, test } from "bun:test";
import { parseConfig, resolveDataDirOverride } from "./data-dir";

const CONFIG_PATH = "/home/u/.config/nisi/config.toml";

function parseTest(contents: string) {
	return parseConfig(contents, CONFIG_PATH, "/home/u");
}

describe("parseConfig", () => {
	test("empty file has no value", () => {
		expect(parseTest("")).toBeNull();
	});

	test("absolute path is returned as written", () => {
		expect(parseTest('data_dir = "/var/nisi"')).toBe("/var/nisi");
	});

	test("leading tilde slash expands to home", () => {
		expect(parseTest('data_dir = "~/nisi-data"')).toBe("/home/u/nisi-data");
	});

	test("relative path is rejected", () => {
		expect(() => parseTest('data_dir = "relative/dir"')).toThrow(
			/config\.toml.*absolute/,
		);
	});

	test("non-string data_dir is rejected", () => {
		expect(() => parseTest("data_dir = 42")).toThrow(CONFIG_PATH);
	});

	test("unknown key is rejected", () => {
		expect(() => parseTest('data_dir = "/var/nisi"\nextra = 1')).toThrow(
			/config\.toml.*extra/,
		);
	});

	test("malformed toml is rejected", () => {
		expect(() => parseTest("data_dir = \n[")).toThrow(CONFIG_PATH);
	});
});

describe("resolveDataDirOverride", () => {
	test("NISI_DATA_DIR wins with any value, even empty", () => {
		expect(resolveDataDirOverride({ NISI_DATA_DIR: "/tmp/x" })).toBe("/tmp/x");
		expect(resolveDataDirOverride({ NISI_DATA_DIR: "" })).toBe("");
	});

	test("HOME is required when NISI_DATA_DIR is unset", () => {
		expect(() => resolveDataDirOverride({})).toThrow("$HOME");
	});

	test("a missing config file means no override", () => {
		expect(
			resolveDataDirOverride({ HOME: "/nonexistent-nisi-test-home" }),
		).toBeNull();
	});
});
