import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveProjectRoot } from "../src/project-root.ts";

const TINY_PROJECT_ROOT = join(import.meta.dir, "fixtures", "tiny-project");

describe("resolveProjectRoot", () => {
	test("walks up from a nested file to the ancestor holding tsconfig.json", () => {
		const greeterTs = join(TINY_PROJECT_ROOT, "src", "greeter.ts");
		expect(resolveProjectRoot(greeterTs)).toBe(TINY_PROJECT_ROOT);
	});

	test("a file directly beside tsconfig.json resolves to its own directory", () => {
		// tsconfig.json itself lives at TINY_PROJECT_ROOT — any file there
		// (not just one under src/) should resolve to that same directory.
		const siblingFile = join(TINY_PROJECT_ROOT, "README.md");
		expect(resolveProjectRoot(siblingFile)).toBe(TINY_PROJECT_ROOT);
	});

	test("a file with no tsconfig.json anywhere above it resolves to null", () => {
		expect(resolveProjectRoot("/tmp/definitely-not-a-project/file.ts")).toBe(
			null,
		);
	});
});
