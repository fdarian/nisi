import { expect, test } from "bun:test";
import { parseLaunchOptions } from "./options.ts";

test("requires cwd and only accepts the checkout-local interface", () => {
	expect(() => parseLaunchOptions([])).toThrow("Usage:");
	expect(() => parseLaunchOptions(["--cwd", "--cold"])).toThrow(
		"requires a PR worktree",
	);
	expect(() => parseLaunchOptions(["--cwd", "/pr", "--nisi", "nisi"])).toThrow(
		"Unknown option: --nisi",
	);
	expect(() => parseLaunchOptions(["--cwd", "/pr", "--rebuild"])).toThrow(
		"--rebuild requires --cold",
	);
	expect(
		parseLaunchOptions(["--cold", "--cwd", "/pr", "--rebuild", "--json"]),
	).toEqual({
		cwd: "/pr",
		cold: true,
		newPr: false,
		rebuild: true,
		json: true,
		waitPrIndex: false,
		shell: "electron",
		memory: false,
		memorySettleMs: 5000,
	});
});

test("shell defaults to electron and rejects unknown shells", () => {
	expect(parseLaunchOptions(["--cwd", "/pr", "--cold"]).shell).toBe("electron");
	expect(
		parseLaunchOptions(["--cwd", "/pr", "--cold", "--shell", "electrobun"])
			.shell,
	).toBe("electrobun");
	expect(() =>
		parseLaunchOptions(["--cwd", "/pr", "--shell", "tauri"]),
	).toThrow("--shell must be one of electron, electrobun");
	expect(() => parseLaunchOptions(["--cwd", "/pr", "--shell"])).toThrow(
		"--shell requires electron or electrobun",
	);
});

test("memory sampling is valid in any mode, and its settle needs --memory", () => {
	expect(parseLaunchOptions(["--cwd", "/pr", "--memory"])).toMatchObject({
		memory: true,
		memorySettleMs: 5000,
	});
	expect(
		parseLaunchOptions([
			"--cwd",
			"/pr",
			"--cold",
			"--memory",
			"--memory-settle",
			"1500",
		]),
	).toMatchObject({ memory: true, memorySettleMs: 1500 });
	expect(() =>
		parseLaunchOptions(["--cwd", "/pr", "--memory-settle", "1500"]),
	).toThrow("--memory-settle requires --memory");
	expect(() =>
		parseLaunchOptions(["--cwd", "/pr", "--memory", "--memory-settle", "soon"]),
	).toThrow("--memory-settle requires a number of milliseconds");
});

test("index waiting is restricted to new-PR measurement mode", () => {
	expect(() => parseLaunchOptions(["--cwd", "/pr", "--wait-pr-index"])).toThrow(
		"--wait-pr-index requires --new-pr",
	);
	expect(
		parseLaunchOptions([
			"--cwd",
			"/pr",
			"--new-pr",
			"--warmup",
			"/warm",
			"--wait-pr-index",
		]).waitPrIndex,
	).toBe(true);
});
