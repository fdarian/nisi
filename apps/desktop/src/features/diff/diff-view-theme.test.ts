import { expect, test } from "bun:test";
import { buildDiffPrewarmOptions } from "./diff-view-theme";

test("prewarm uses the configured syntax themes, not GitHub defaults", () => {
	const options = buildDiffPrewarmOptions({
		light: "pierre-light",
		dark: "dracula",
	});
	expect(options.theme).toEqual({ light: "pierre-light", dark: "dracula" });
	expect(options.langs).toEqual(["typescript", "tsx", "javascript", "json"]);
});
