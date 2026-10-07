import { expect, test } from "bun:test";
import { prViewTabs } from "./pr-view-tab-strip";

test("Walkthrough joins the strip between Overview and Files Changed only when enabled", () => {
	expect(prViewTabs(true).map((tab) => tab.value)).toEqual([
		"overview",
		"walkthrough",
		"files",
	]);
	expect(prViewTabs(false).map((tab) => tab.value)).toEqual([
		"overview",
		"files",
	]);
});
