import { describe, expect, test } from "bun:test";
import {
	buildBackgroundTasks,
	type ScheduledMergeEntry,
} from "./background-tasks-data.ts";

function scheduled(
	number: number,
	overrides: Partial<ScheduledMergeEntry> = {},
): ScheduledMergeEntry {
	return {
		repoRoot: "/code/acme/widgets",
		owner: "acme",
		repo: "widgets",
		number,
		method: "squash",
		route: "merge",
		createdAt: number,
		...overrides,
	};
}

function pendingMerge(number: number, route: "merge" | "stack" = "merge") {
	return {
		route,
		params: {
			repoRoot: "/code/acme/widgets",
			owner: "acme",
			repo: "widgets",
			number,
			method: "merge" as const,
		},
	};
}

describe("buildBackgroundTasks", () => {
	test("lists scheduled merges before immediate merges", () => {
		const tasks = buildBackgroundTasks({
			scheduled: [scheduled(2)],
			pendingMerges: [pendingMerge(3, "stack")],
			openPullRequests: [],
		});
		expect(tasks.map((task) => [task.kind, task.number, task.route])).toEqual([
			["scheduled-merge", 2, "merge"],
			["merging", 3, "stack"],
		]);
	});

	test("orders scheduled merges by when they were scheduled", () => {
		const tasks = buildBackgroundTasks({
			scheduled: [
				scheduled(1, { createdAt: 30 }),
				scheduled(2, { createdAt: 10 }),
			],
			pendingMerges: [],
			openPullRequests: [],
		});
		expect(tasks.map((task) => task.number)).toEqual([2, 1]);
	});

	test("drops tasks whose PR has an open tab, matching owner and repo case-insensitively", () => {
		const tasks = buildBackgroundTasks({
			scheduled: [scheduled(1), scheduled(2)],
			pendingMerges: [pendingMerge(3), pendingMerge(4)],
			openPullRequests: [
				{ owner: "ACME", repo: "Widgets", number: 1 },
				{ owner: "acme", repo: "widgets", number: 4 },
			],
		});
		expect(tasks.map((task) => task.number)).toEqual([2, 3]);
	});

	test("keeps a task when only the number differs from an open tab", () => {
		const tasks = buildBackgroundTasks({
			scheduled: [scheduled(1)],
			pendingMerges: [],
			openPullRequests: [{ owner: "acme", repo: "widgets", number: 2 }],
		});
		expect(tasks).toHaveLength(1);
	});

	test("carries the title only when the sidecar knew it", () => {
		const tasks = buildBackgroundTasks({
			scheduled: [scheduled(1, { title: "Add widgets" }), scheduled(2)],
			pendingMerges: [],
			openPullRequests: [],
		});
		expect(tasks.map((task) => task.title)).toEqual(["Add widgets", undefined]);
		expect("title" in tasks[1]).toBe(false);
	});

	test("returns nothing when there is nothing in the background", () => {
		expect(
			buildBackgroundTasks({
				scheduled: [],
				pendingMerges: [],
				openPullRequests: [],
			}),
		).toEqual([]);
	});
});
