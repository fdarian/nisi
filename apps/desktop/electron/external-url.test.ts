import { describe, expect, test } from "bun:test";
import { isHttpUrl, isOpenUrlAllowed } from "./external-url";

describe("isOpenUrlAllowed", () => {
	test("allows web, mail and tel", () => {
		for (const url of [
			"https://github.com/a/b",
			"http://localhost:1",
			"mailto:a@b.c",
			"tel:+123",
		]) {
			expect(isOpenUrlAllowed(url)).toBe(true);
		}
	});

	test("allows exactly the Notifications settings pane", () => {
		const pane =
			"x-apple.systempreferences:com.apple.Notifications-Settings.extension";
		expect(isOpenUrlAllowed(pane)).toBe(true);
		expect(
			isOpenUrlAllowed("x-apple.systempreferences:com.apple.Security"),
		).toBe(false);
	});

	test("rejects everything else", () => {
		for (const url of [
			"file:///etc/passwd",
			"javascript:alert(1)",
			"nope",
			"",
		]) {
			expect(isOpenUrlAllowed(url)).toBe(false);
		}
	});
});

describe("isHttpUrl", () => {
	test("only http and https", () => {
		expect(isHttpUrl("https://a.b")).toBe(true);
		expect(isHttpUrl("mailto:a@b.c")).toBe(false);
		expect(isHttpUrl("app://nisi/")).toBe(false);
	});
});
