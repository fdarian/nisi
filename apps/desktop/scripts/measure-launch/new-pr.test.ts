import { expect, test } from "bun:test";
import { validateNewPr } from "./new-pr.ts";
import { parseLaunchOptions } from "./options.ts";
import { windowWentHidden } from "./run.ts";

test("new-PR mode requires a separate warm-up and is exclusive with cold", () => {
	expect(() => parseLaunchOptions(["--cwd", "/target", "--new-pr"])).toThrow(
		"requires --warmup",
	);
	expect(() =>
		parseLaunchOptions(["--cwd", "/target", "--warmup", "/other"]),
	).toThrow("requires --new-pr");
	expect(() =>
		parseLaunchOptions([
			"--cwd",
			"/target",
			"--cold",
			"--new-pr",
			"--warmup",
			"/other",
		]),
	).toThrow("mutually exclusive");
	expect(
		parseLaunchOptions([
			"--cwd",
			"/target",
			"--new-pr",
			"--warmup",
			"/other",
			"--rebuild",
		]).warmup,
	).toBe("/other");
});
test("rejects identical PRs, branches and different repositories before resetting data", () => {
	const target = { clone: "/repo", branch: "target", pr: "acme/repo#1" };
	expect(() => validateNewPr(target, { ...target, branch: "other" })).toThrow(
		"same PR or branch",
	);
	expect(() => validateNewPr(target, { ...target, pr: "acme/repo#2" })).toThrow(
		"same PR or branch",
	);
	expect(() => validateNewPr(target, { ...target, clone: "/other" })).toThrow(
		"same repository",
	);
	expect(
		validateNewPr(target, { ...target, branch: "other", pr: "acme/repo#2" }),
	).toBe("acme/repo#2");
});
test("initial hidden activation is allowed but losing visibility stops measurement", () => {
	const marks = [true, false, true].map((hidden) => ({
		type: "mark" as const,
		source: "frontend" as const,
		name: "frontend.visibility",
		at: 1,
		attrs: { hidden },
	}));
	expect(windowWentHidden(marks.slice(0, 2))).toBe(false);
	expect(windowWentHidden(marks)).toBe(true);
});
