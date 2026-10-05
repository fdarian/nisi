import { expect, test } from "bun:test";
import type { LaunchRecord } from "@repo/sidecar-api";
import {
	createdWorktrees,
	parseMeasurementPr,
	validateDeepLinkTargets,
} from "./deeplink.ts";
import { parseLaunchOptions } from "./options.ts";
import { formatTimeline } from "./format.ts";

test("deep-link mode requires managed instances and preserves warm-up URL", () => {
	expect(() =>
		parseLaunchOptions([
			"--cwd",
			"/repo",
			"--deeplink",
			"https://github.com/a/b/pull/1",
		]),
	).toThrow("managed");
	expect(
		parseLaunchOptions([
			"--cwd",
			"/repo",
			"--new-pr",
			"--deeplink",
			"https://github.com/a/b/pull/1",
			"--warmup",
			"https://github.com/a/b/pull/2",
		]).warmup,
	).toBe("https://github.com/a/b/pull/2");
	const target = parseMeasurementPr("https://github.com/a/b/pull/1");
	expect(() => validateDeepLinkTargets(target, target)).toThrow("same PR");
	expect(() =>
		validateDeepLinkTargets(
			target,
			parseMeasurementPr("https://github.com/a/c/pull/2"),
		),
	).toThrow("same repository");
	expect(() => parseMeasurementPr("nisi://open")).toThrow("Expected https");
});
test("cleanup requires a successful worktree-add in this run and excludes existing/unrelated registrations", () => {
	const records: LaunchRecord[] = [
		{
			type: "span",
			source: "sidecar",
			name: "subprocess",
			start: 0,
			end: 1,
			spanId: "add",
			attrs: {
				command: "git",
				args: ["worktree", "add", "/created", "branch"],
				exitCode: 0,
			},
		},
	];
	expect(
		createdWorktrees(
			["/existing"],
			["/existing", "/created", "/unrelated"],
			records,
		),
	).toEqual(["/created"]);
	expect(createdWorktrees(["/created"], ["/created"], records)).toEqual([]);
	expect(
		createdWorktrees(
			[],
			["/created"],
			[
				{
					...(records[0] as LaunchRecord),
					attrs: { args: ["worktree", "add", "/created"], exitCode: 1 },
				},
			],
		),
	).toEqual([]);
});
test("deep-link reports start at frontend receipt or cold bundle launch, never infer CLI milestones", () => {
	const records: LaunchRecord[] = [
		"deeplink.received",
		"deeplink.dequeued",
		"pull-requests.open.resolved",
		"files.list.painted",
		"files.first-diff.painted",
		"tab.content.painted",
		"trace.done",
	].map((name, index) => ({
		type: "mark",
		source: "frontend",
		name,
		at: 100 + index * 10,
		attrs: {},
	}));
	expect(formatTimeline(records)).toContain("frontend deep-link receipt");
	expect(formatTimeline(records)).toContain("pending-panel.painted: N/A");
	expect(
		formatTimeline([
			{
				type: "mark",
				source: "cli",
				name: "measurement.app-launch.start",
				at: 0,
				attrs: {},
			},
			...records,
		]),
	).toContain("managed app launch");
});
