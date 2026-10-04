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
	).toEqual({ cwd: "/pr", cold: true, rebuild: true, json: true });
});
