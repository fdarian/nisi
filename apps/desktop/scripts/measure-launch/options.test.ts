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
		memory: false,
		memorySettleMs: 5000,
		soak: false,
		soakPrs: [],
		soakIntervalMs: 2000,
		soakIdleMs: 60_000,
	});
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

test("soak needs a cold deep-link run and takes its own tuning flags", () => {
	const pr = "https://github.com/fdarian/nisi/pull/158";
	expect(
		parseLaunchOptions(["--cwd", "/pr", "--cold", "--deeplink", pr, "--soak"]),
	).toMatchObject({
		soak: true,
		soakPrs: [],
		soakIntervalMs: 2000,
		soakIdleMs: 60_000,
	});
	expect(
		parseLaunchOptions([
			"--cwd",
			"/pr",
			"--cold",
			"--deeplink",
			pr,
			"--soak",
			"--soak-prs",
			"https://github.com/fdarian/nisi/pull/163, https://github.com/fdarian/nisi/pull/87",
			"--soak-interval",
			"500",
			"--soak-idle",
			"0",
		]),
	).toMatchObject({
		soakPrs: [
			"https://github.com/fdarian/nisi/pull/163",
			"https://github.com/fdarian/nisi/pull/87",
		],
		soakIntervalMs: 500,
		soakIdleMs: 0,
	});
	expect(() => parseLaunchOptions(["--cwd", "/pr", "--soak"])).toThrow(
		"--soak requires --cold and --deeplink",
	);
	expect(() =>
		parseLaunchOptions(["--cwd", "/pr", "--cold", "--soak"]),
	).toThrow("--soak requires --cold and --deeplink");
	expect(() =>
		parseLaunchOptions(["--cwd", "/pr", "--cold", "--soak-idle", "10"]),
	).toThrow("--soak-idle requires --soak");
	expect(() =>
		parseLaunchOptions([
			"--cwd",
			"/pr",
			"--cold",
			"--deeplink",
			pr,
			"--soak",
			"--soak-interval",
			"fast",
		]),
	).toThrow("--soak-interval requires a number of milliseconds");
	expect(() =>
		parseLaunchOptions([
			"--cwd",
			"/pr",
			"--cold",
			"--deeplink",
			pr,
			"--soak",
			"--soak-prs",
			" , ",
		]),
	).toThrow("--soak-prs requires a comma-separated list");
});
