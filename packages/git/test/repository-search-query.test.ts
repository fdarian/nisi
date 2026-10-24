import { describe, expect, test } from "bun:test";
import { repositorySearchQuery } from "../src/github/gh/repository-search.ts";

describe("repositorySearchQuery", () => {
	test("plain text matches repository names", () => {
		expect(repositorySearchQuery("nisi")).toBe("nisi in:name fork:true");
	});

	test("trims surrounding whitespace", () => {
		expect(repositorySearchQuery("  nisi  ")).toBe("nisi in:name fork:true");
	});

	test("owner/name scopes to the owner", () => {
		expect(repositorySearchQuery("fdarian/ni")).toBe(
			"user:fdarian ni in:name fork:true",
		);
	});

	test("owner/ with no name lists the owner's repositories", () => {
		expect(repositorySearchQuery("fdarian/")).toBe("user:fdarian fork:true");
	});
});
