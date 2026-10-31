import { describe, expect, test } from "bun:test";
import type { FileChange } from "#/features/pull-request/data/pr-data";
import { buildRenameMarkerCSS } from "./tree-shadow-dom";

function file(overrides: Partial<FileChange>): FileChange {
	return {
		path: "src/a.ts",
		status: "renamed",
		category: "implementation",
		additions: 0,
		deletions: 0,
		fingerprint: "fp",
		binary: false,
		review: null,
		...overrides,
	};
}

const DIM_RULE = "opacity: 0.58";

describe("buildRenameMarkerCSS", () => {
	test("pure rename gets the hollow marker and is dimmed", () => {
		const css = buildRenameMarkerCSS([file({})]);
		expect(css).toContain('[data-item-path="src/a.ts"]');
		expect(css).toContain(DIM_RULE);
		expect(css).toContain('[data-item-selected="true"]');
	});

	test("rename with edits gets a marker but no dimming", () => {
		const css = buildRenameMarkerCSS([file({ additions: 3 })]);
		expect(css).toContain("mask-image");
		expect(css).not.toContain("opacity");
		expect(buildRenameMarkerCSS([file({ deletions: 1 })])).not.toContain(
			"opacity",
		);
	});

	test("hollow and solid markers use different masks", () => {
		const pure = buildRenameMarkerCSS([file({})]);
		const edited = buildRenameMarkerCSS([file({ additions: 1 })]);
		const mask = (css: string) => css.match(/mask-image: (url\(.*\));/)?.[1];
		expect(mask(pure)).toBeDefined();
		expect(mask(pure)).not.toBe(mask(edited));
	});

	test("a binary rename counts as edited even at 0/0", () => {
		const css = buildRenameMarkerCSS([file({ binary: true })]);
		expect(css).toContain("mask-image");
		expect(css).not.toContain("opacity");
	});

	test("non-renamed files are ignored", () => {
		const css = buildRenameMarkerCSS([
			file({ status: "modified" }),
			file({ status: "added", additions: 4 }),
			file({ status: "deleted", deletions: 4 }),
		]);
		expect(css).toBe("");
	});

	test("escapes quotes and backslashes in paths", () => {
		const css = buildRenameMarkerCSS([file({ path: 'a"b\\c.ts' })]);
		expect(css).toContain('[data-item-path="a\\"b\\\\c.ts"]');
	});
});
