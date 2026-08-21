import { describe, expect, test } from "bun:test";
import { parseCaskListVersion } from "../homebrew.ts";

describe("parseCaskListVersion", () => {
	test("reads the version off a normal `brew list --cask --versions <token>` line", () => {
		expect(parseCaskListVersion("nisi 0.2.3\n", "nisi")).toBe("0.2.3");
	});

	test("tolerates missing trailing newline", () => {
		expect(parseCaskListVersion("nisi 0.2.3", "nisi")).toBe("0.2.3");
	});

	test("skips blank leading lines", () => {
		expect(parseCaskListVersion("\n\nnisi 0.2.3\n", "nisi")).toBe("0.2.3");
	});

	test("returns undefined for empty stdout — brew found nothing installed", () => {
		expect(parseCaskListVersion("", "nisi")).toBeUndefined();
	});

	test("returns undefined when the line names a different cask", () => {
		expect(
			parseCaskListVersion("some-other-cask 1.0.0\n", "nisi"),
		).toBeUndefined();
	});

	test("reads only the first version token when multiple are listed", () => {
		expect(parseCaskListVersion("nisi 0.2.2 0.2.3\n", "nisi")).toBe("0.2.2");
	});
});
