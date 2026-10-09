import { describe, expect, test } from "bun:test";
import type {
	RepositorySession,
	RepositorySessionStateBatch,
	RepositorySummary,
} from "@repo/sidecar-api";
import {
	countPending,
	filterRepositories,
	filterSessions,
	formatRemote,
	INITIAL_SESSION_COUNT,
	mergeSessionStates,
	relativeTime,
	type SessionRow,
	sessionSummary,
	splitVisibleSessions,
	tildePath,
} from "./repositories-view";

const summary = (
	overrides: Partial<RepositorySummary> = {},
): RepositorySummary => ({
	owner: "fdarian",
	repo: "nisi",
	path: "/Users/me/code/fdarian/nisi",
	openCount: 0,
	sessionCount: 0,
	problem: null,
	...overrides,
});

const session = (
	prNumber: number,
	state: "open" | "merged" | "closed" | "unresolved" | "pending",
	prTitle = `PR ${prNumber}`,
): SessionRow => ({
	id: `s${prNumber}`,
	prNumber,
	prTitle,
	state:
		state === "unresolved"
			? { kind: "unresolved", reason: "rate limited" }
			: state === "pending"
				? { kind: "pending" }
				: { kind: "resolved", state },
	updatedAt: 0,
});

const listed = (
	prNumber: number,
	state: "open" | "merged" | "closed" | "pending",
): RepositorySession => {
	const row = session(prNumber, state);
	if (row.state.kind === "unresolved") throw new Error("not a listed state");
	return { ...row, state: row.state };
};

const resolution = (
	prNumber: number,
	state: "open" | "merged" | "closed" | "unresolved",
): RepositorySessionStateBatch[number] => {
	const row = session(prNumber, state);
	if (row.state.kind === "pending") throw new Error("not a resolution");
	return { prNumber, state: row.state };
};

describe("tildePath", () => {
	test("abbreviates only paths inside the home directory", () => {
		expect(tildePath("/Users/me/code/nisi", "/Users/me")).toBe("~/code/nisi");
		expect(tildePath("/Users/me", "/Users/me/")).toBe("~");
		expect(tildePath("/Users/meagan/code", "/Users/me")).toBe(
			"/Users/meagan/code",
		);
		expect(tildePath("/opt/nisi", "/Users/me")).toBe("/opt/nisi");
	});

	test("leaves the path alone until the home directory is known", () => {
		expect(tildePath("/Users/me/code", undefined)).toBe("/Users/me/code");
	});
});

describe("formatRemote", () => {
	test("normalizes https, scp-style and ssh:// remotes to host/owner/repo", () => {
		expect(formatRemote("https://github.com/fdarian/nisi.git")).toBe(
			"github.com/fdarian/nisi",
		);
		expect(formatRemote("git@github.com:fdarian/nisi.git")).toBe(
			"github.com/fdarian/nisi",
		);
		expect(formatRemote("ssh://git@github.com/fdarian/nisi")).toBe(
			"github.com/fdarian/nisi",
		);
		expect(formatRemote("https://user:token@github.com/o/r/")).toBe(
			"github.com/o/r",
		);
	});
});

describe("sessionSummary", () => {
	test("omits a zero open count and pluralizes", () => {
		expect(sessionSummary(summary({ openCount: 2, sessionCount: 50 }))).toBe(
			"2 open · 50 sessions",
		);
		expect(sessionSummary(summary({ sessionCount: 8 }))).toBe("8 sessions");
		expect(sessionSummary(summary({ sessionCount: 1 }))).toBe("1 session");
		expect(sessionSummary(summary())).toBe("No sessions");
	});
});

describe("filterRepositories", () => {
	const repositories = [
		summary(),
		summary({ owner: "vercel", repo: "next.js", path: "/Users/me/vercel" }),
		summary({ owner: "acme", repo: "web", path: null }),
	];

	test("matches owner/repo and path, ignoring case and whitespace", () => {
		expect(
			filterRepositories(repositories, " NEXT ").map((entry) => entry.repo),
		).toEqual(["next.js"]);
		expect(
			filterRepositories(repositories, "me/code").map((entry) => entry.repo),
		).toEqual(["nisi"]);
		expect(filterRepositories(repositories, "fdarian/nisi")).toHaveLength(1);
	});

	test("an empty query keeps everything, including repositories with no path", () => {
		expect(filterRepositories(repositories, "  ")).toHaveLength(3);
	});
});

describe("filterSessions", () => {
	const sessions = [
		session(151, "open", "Walkthrough claims link to line ranges"),
		session(148, "merged", "Keep merge status fresh"),
		session(12, "closed", "Try something"),
		session(7, "unresolved", "Lookup failed"),
	];

	test("narrows by tab", () => {
		expect(
			filterSessions(sessions, "merged", "").map((entry) => entry.prNumber),
		).toEqual([148]);
		expect(filterSessions(sessions, "all", "")).toHaveLength(4);
	});

	test("shows sessions whose state couldn't be resolved only under all", () => {
		expect(
			filterSessions(sessions, "all", "").map((entry) => entry.prNumber),
		).toContain(7);
		for (const tab of ["open", "merged", "closed"] as const)
			expect(
				filterSessions(sessions, tab, "").map((entry) => entry.prNumber),
			).not.toContain(7);
	});

	test("matches a title substring or a PR number, with or without #", () => {
		expect(
			filterSessions(sessions, "all", "FRESH").map((entry) => entry.prNumber),
		).toEqual([148]);
		expect(
			filterSessions(sessions, "all", "#15").map((entry) => entry.prNumber),
		).toEqual([151]);
		expect(filterSessions(sessions, "open", "148")).toHaveLength(0);
	});
});

describe("filterSessions while states stream in", () => {
	const rows = mergeSessionStates(
		[
			listed(5, "pending"),
			listed(4, "pending"),
			listed(3, "open"),
			listed(2, "pending"),
		],
		[[resolution(4, "merged")]],
		null,
	);

	test("a tab holds only the sessions that have resolved to it so far, and grows with each event", () => {
		const numbers = (tab: "all" | "open" | "merged" | "closed") =>
			filterSessions(rows, tab, "").map((entry) => entry.prNumber);
		expect(numbers("merged")).toEqual([4]);
		expect(numbers("open")).toEqual([3]);
		expect(numbers("closed")).toEqual([]);

		const later = mergeSessionStates(
			[
				listed(5, "pending"),
				listed(4, "pending"),
				listed(3, "open"),
				listed(2, "pending"),
			],
			[
				[resolution(4, "merged")],
				[resolution(5, "merged"), resolution(2, "closed")],
			],
			null,
		);
		expect(
			filterSessions(later, "merged", "").map((entry) => entry.prNumber),
		).toEqual([5, 4]);
		expect(
			filterSessions(later, "closed", "").map((entry) => entry.prNumber),
		).toEqual([2]);
	});

	test("the all tab keeps every row, pending ones included, in their original order", () => {
		expect(
			filterSessions(rows, "all", "").map((entry) => entry.prNumber),
		).toEqual([5, 4, 3, 2]);
	});
});

describe("mergeSessionStates", () => {
	const sessions = [
		listed(5, "pending"),
		listed(4, "pending"),
		listed(3, "open"),
	];

	test("fills pending sessions from the events and leaves the rest pending", () => {
		const merged = mergeSessionStates(
			sessions,
			[[resolution(4, "merged")]],
			null,
		);
		expect(merged.map((entry) => entry.state)).toEqual([
			{ kind: "pending" },
			{ kind: "resolved", state: "merged" },
			{ kind: "resolved", state: "open" },
		]);
		expect(countPending(merged)).toBe(1);
	});

	test("a later event for the same PR wins", () => {
		const merged = mergeSessionStates(
			sessions,
			[[resolution(5, "unresolved")], [resolution(5, "closed")]],
			null,
		);
		expect(merged[0]?.state).toEqual({ kind: "resolved", state: "closed" });
	});

	test("an unresolved result is kept, with its reason", () => {
		const merged = mergeSessionStates(
			sessions,
			[[resolution(5, "unresolved")]],
			null,
		);
		expect(merged[0]?.state).toEqual({
			kind: "unresolved",
			reason: "rate limited",
		});
	});

	test("every session of a reused PR number gets the state", () => {
		const reused = [
			listed(7, "pending"),
			{ ...listed(7, "pending"), id: "s7-again" },
		];
		const merged = mergeSessionStates(
			reused,
			[[resolution(7, "merged")]],
			null,
		);
		expect(merged.map((entry) => entry.state)).toEqual([
			{ kind: "resolved", state: "merged" },
			{ kind: "resolved", state: "merged" },
		]);
	});

	test("an event never overrides what the listing already resolved", () => {
		const merged = mergeSessionStates(
			sessions,
			[[resolution(3, "closed")]],
			null,
		);
		expect(merged[2]?.state).toEqual({ kind: "resolved", state: "open" });
	});

	test("a failed stream turns what is still pending into unresolved, keeping what arrived", () => {
		const merged = mergeSessionStates(
			sessions,
			[[resolution(4, "merged")]],
			"sidecar went away",
		);
		expect(merged.map((entry) => entry.state)).toEqual([
			{ kind: "unresolved", reason: "sidecar went away" },
			{ kind: "resolved", state: "merged" },
			{ kind: "resolved", state: "open" },
		]);
		expect(countPending(merged)).toBe(0);
	});

	test("without events it is the listing as-is", () => {
		expect(mergeSessionStates(sessions, [], null)).toEqual(sessions);
	});
});

describe("splitVisibleSessions", () => {
	const many = Array.from({ length: 10 }, (_, index) => session(index, "open"));

	test("collapses to the first seven and counts the rest", () => {
		const split = splitVisibleSessions(many, false);
		expect(split.shown).toHaveLength(INITIAL_SESSION_COUNT);
		expect(split.hiddenCount).toBe(3);
	});

	test("shows everything once expanded or when nothing would be hidden", () => {
		expect(splitVisibleSessions(many, true).hiddenCount).toBe(0);
		expect(splitVisibleSessions(many.slice(0, 7), false).shown).toHaveLength(7);
	});
});

describe("relativeTime", () => {
	const now = Date.UTC(2026, 9, 8, 12);
	const ago = (ms: number) => relativeTime(now - ms, now);

	test("uses the largest whole unit", () => {
		expect(ago(10_000)).toBe("now");
		expect(ago(5 * 60_000)).toBe("5m");
		expect(ago(2 * 3_600_000)).toBe("2h");
		expect(ago(3 * 86_400_000)).toBe("3d");
		expect(ago(15 * 86_400_000)).toBe("2w");
		expect(ago(90 * 86_400_000)).toBe("3mo");
		expect(ago(800 * 86_400_000)).toBe("2y");
	});

	test("a timestamp in the future reads as now", () => {
		expect(relativeTime(now + 5000, now)).toBe("now");
	});
});
