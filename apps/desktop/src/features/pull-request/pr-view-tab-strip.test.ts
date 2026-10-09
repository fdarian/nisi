import { expect, test } from "bun:test";
import { prViewTabs } from "./pr-view-tab-strip";

test("Walkthrough joins the strip after Overview only when enabled; Guide is always there", () => {
	expect(prViewTabs(true).map((tab) => tab.value)).toEqual([
		"overview",
		"walkthrough",
		"guide",
		"files",
	]);
	expect(prViewTabs(false).map((tab) => tab.value)).toEqual([
		"overview",
		"guide",
		"files",
	]);
});
