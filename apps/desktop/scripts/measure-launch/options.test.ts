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
	});
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
