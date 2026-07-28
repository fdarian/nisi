import { describe, expect, test } from "bun:test";
import { buildDigest, type DigestFile, renderDigest } from "../src/digest.ts";

const digestFile = (
	overrides: Partial<DigestFile> & { path: string },
): DigestFile => ({
	oldPath: undefined,
	status: "modified",
	category: "implementation",
	additions: 1,
	deletions: 0,
	fingerprint: overrides.path,
	binary: false,
	patch: "",
	...overrides,
});

describe("buildDigest", () => {
	test("keeps a small file's patch intact under a generous budget", () => {
		const [entry] = buildDigest(
			[digestFile({ path: "a.ts", patch: "small patch" })],
			{
				totalChars: 1000,
				perFileChars: 500,
			},
		);
		expect(entry).toMatchObject({
			patchExcerpt: "small patch",
			truncated: false,
		});
	});

	test("caps a single file at perFileChars even with total budget to spare", () => {
		const [entry] = buildDigest(
			[digestFile({ path: "a.ts", patch: "x".repeat(1000) })],
			{
				totalChars: 100_000,
				perFileChars: 50,
			},
		);
		expect(entry?.patchExcerpt.length).toBe(50);
		expect(entry?.truncated).toBe(true);
	});

	test("shrinks the budget as files consume it, degrading later files instead of failing", () => {
		const files = [
			digestFile({ path: "a.ts", patch: "A".repeat(3000) }),
			digestFile({ path: "b.ts", patch: "B".repeat(3000) }),
			digestFile({ path: "c.ts", patch: "C".repeat(3000) }),
		];

		const entries = buildDigest(files, {
			totalChars: 5000,
			perFileChars: 4000,
		});

		expect(entries[0]).toMatchObject({
			patchExcerpt: "A".repeat(3000),
			truncated: false,
		});
		expect(entries[1]?.patchExcerpt.length).toBe(2000);
		expect(entries[1]?.truncated).toBe(true);
		expect(entries[2]?.patchExcerpt.length).toBe(0);
		expect(entries[2]?.truncated).toBe(true);
	});

	test("never sends patch text for a binary file", () => {
		const [entry] = buildDigest([
			digestFile({
				path: "image.png",
				binary: true,
				patch: "should not appear",
			}),
		]);
		expect(entry?.patchExcerpt).toBe("");
	});

	test("carries oldPath through for a rename", () => {
		const [entry] = buildDigest([
			digestFile({ path: "new.ts", oldPath: "old.ts", status: "renamed" }),
		]);
		expect(entry?.oldPath).toBe("old.ts");
	});
});

describe("renderDigest", () => {
	test("reports no changed files", () => {
		expect(renderDigest([])).toBe("No changed files.");
	});

	test("renders a file's header, status, and patch excerpt", () => {
		const entries = buildDigest([
			digestFile({ path: "a.ts", patch: "+added line" }),
		]);
		const text = renderDigest(entries);
		expect(text).toContain("a.ts");
		expect(text).toContain("modified");
		expect(text).toContain("implementation");
		expect(text).toContain("+added line");
	});

	test("marks a binary file instead of showing an empty diff", () => {
		const entries = buildDigest([
			digestFile({ path: "image.png", binary: true }),
		]);
		expect(renderDigest(entries)).toContain("binary file");
	});

	test("flags budget exhaustion distinctly from a normal truncation", () => {
		const entries = buildDigest(
			[
				digestFile({ path: "a.ts", patch: "A".repeat(10) }),
				digestFile({ path: "b.ts", patch: "B".repeat(10) }),
			],
			{ totalChars: 10, perFileChars: 10 },
		);
		const text = renderDigest(entries);
		expect(text).toContain("budget exhausted");
	});
});
