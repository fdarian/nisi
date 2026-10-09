import { expect, test } from "bun:test";
import { prViewTabs } from "./pr-view-tab-strip";

function values(options: {
	walkthroughEnabled: boolean;
	guideExists: boolean;
}) {
	return prViewTabs(options).map((tab) => tab.value);
}

test("Walkthrough and Guide each join the strip only when they exist", () => {
	expect(values({ walkthroughEnabled: true, guideExists: true })).toEqual([
		"overview",
		"walkthrough",
		"guide",
		"files",
	]);
	expect(values({ walkthroughEnabled: false, guideExists: true })).toEqual([
		"overview",
		"guide",
		"files",
	]);
	expect(values({ walkthroughEnabled: true, guideExists: false })).toEqual([
		"overview",
		"walkthrough",
		"files",
	]);
});

test("without a guide, Files Changed takes the next digit shortcut", () => {
	expect(values({ walkthroughEnabled: false, guideExists: false })).toEqual([
		"overview",
		"files",
	]);
});
