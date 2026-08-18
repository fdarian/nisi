import { describe, expect, test } from "bun:test";
import { buildOverview, type OverviewInput } from "../src/overview.ts";

const baseInput: OverviewInput = {
	baseRef: "main",
	headRef: "feature/x",
	includeUncommitted: false,
	files: [],
};

const file = (
	overrides: Partial<OverviewInput["files"][number]> & { path: string },
) => ({
	oldPath: undefined,
	status: "modified" as const,
	category: "implementation" as const,
	additions: 1,
	deletions: 0,
	fingerprint: overrides.path,
	binary: false,
	...overrides,
});

describe("buildOverview", () => {
	test("states the base and head refs explicitly", () => {
		const text = buildOverview(baseInput);
		expect(text).toContain("`main`");
		expect(text).toContain("`feature/x`");
	});

	test("tells the agent it can reproduce the diff itself via git", () => {
		const text = buildOverview(baseInput);
		expect(text).toContain("git diff main...feature/x");
		expect(text).toContain("real worktree");
	});

	test("notes when uncommitted changes are folded into the diff", () => {
		const text = buildOverview({ ...baseInput, includeUncommitted: true });
		expect(text).toContain("including its uncommitted changes");
	});

	test("notes when uncommitted changes are excluded", () => {
		const text = buildOverview({ ...baseInput, includeUncommitted: false });
		expect(text).toContain("excluding any uncommitted changes");
	});

	test("reports no changed files", () => {
		expect(buildOverview(baseInput)).toContain("No changed files.");
	});

	test("renders a file's path, status, category, and added/deleted counts — no patch text", () => {
		const text = buildOverview({
			...baseInput,
			files: [file({ path: "a.ts", additions: 12, deletions: 3 })],
		});
		expect(text).toContain("a.ts");
		expect(text).toContain("modified");
		expect(text).toContain("implementation");
		expect(text).toContain("+12/-3");
	});

	test("shows old -> new for a rename", () => {
		const text = buildOverview({
			...baseInput,
			files: [
				file({
					path: "new.ts",
					oldPath: "old.ts",
					status: "renamed",
				}),
			],
		});
		expect(text).toContain("old.ts -> new.ts");
	});

	test("includes the PR title when the session has one", () => {
		const text = buildOverview({
			...baseInput,
			pullRequestTitle: "Add optimistic complete toggle",
		});
		expect(text).toContain("Pull request");
		expect(text).toContain("Add optimistic complete toggle");
	});

	test("omits the PR section entirely when the session has no PR, rather than an empty section", () => {
		const text = buildOverview(baseInput);
		expect(text).not.toContain("Pull request");
	});
});
