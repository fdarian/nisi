import { expect, test } from "bun:test";
import { offersRecentlyClosedFilter } from "./recently-closed-filter";

test("offers the filter for a prefix of closed, recently closed, or merged", () => {
	expect(offersRecentlyClosedFilter("cl")).toBe(true);
	expect(offersRecentlyClosedFilter("closed")).toBe(true);
	expect(offersRecentlyClosedFilter("  Recently Cl ")).toBe(true);
	expect(offersRecentlyClosedFilter("mer")).toBe(true);
	expect(offersRecentlyClosedFilter("merged")).toBe(true);
});

test("does not offer the filter for short or non-matching queries", () => {
	expect(offersRecentlyClosedFilter("")).toBe(false);
	expect(offersRecentlyClosedFilter("c")).toBe(false);
	expect(offersRecentlyClosedFilter(" m ")).toBe(false);
	expect(offersRecentlyClosedFilter("closedx")).toBe(false);
	expect(offersRecentlyClosedFilter("fix")).toBe(false);
});
