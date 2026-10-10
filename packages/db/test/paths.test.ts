import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import { readConfigFileDataDir } from "../src/paths.ts";

describe("readConfigFileDataDir", () => {
	let dir: string;
	let configPath: string;
	const home = "/Users/someone";

	const read = () =>
		Effect.runPromiseExit(readConfigFileDataDir(configPath, home));
	const write = (contents: string) => writeFile(configPath, contents);

	const expectFailure = async (messagePart: string) => {
		const exit = await read();
		expect(Exit.isFailure(exit)).toBe(true);
		const message = String(Exit.isFailure(exit) ? exit.cause : "");
		expect(message).toContain(configPath);
		expect(message).toContain(messagePart);
	};

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "nisi-paths-test-"));
		configPath = join(dir, "config.toml");
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test("a missing file yields no value", async () => {
		expect(await read()).toEqual(Exit.succeed(undefined));
	});

	test("an empty file yields no value", async () => {
		await write("");
		expect(await read()).toEqual(Exit.succeed(undefined));
	});

	test("returns an absolute data_dir as written", async () => {
		await write('data_dir = "/var/nisi"\n');
		expect(await read()).toEqual(Exit.succeed("/var/nisi"));
	});

	test("expands a leading ~/ to home", async () => {
		await write('data_dir = "~/nisi-data"\n');
		expect(await read()).toEqual(Exit.succeed("/Users/someone/nisi-data"));
	});

	test("rejects a relative path", async () => {
		await write('data_dir = "relative/dir"\n');
		await expectFailure("absolute");
	});

	test("rejects a non-string data_dir", async () => {
		await write("data_dir = 42\n");
		await expectFailure("must be a string");
	});

	test("rejects an unknown key", async () => {
		await write('data_dir = "/var/nisi"\ndata_dirr = "/oops"\n');
		await expectFailure("unknown key");
	});

	test("rejects malformed TOML", async () => {
		await write("data_dir = \n[");
		await expectFailure("not valid TOML");
	});
});
