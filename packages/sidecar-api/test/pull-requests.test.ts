import { expect, test } from "bun:test";
import { contract } from "../src/contract.ts";

test("search requires repository filters alongside the query", async () => {
	const schema = contract.pullRequests.search["~orpc"].inputSchemas[0];
	expect(schema).toBeDefined();
	if (schema === undefined) return;
	const input = {
		query: "fix",
		repos: ["acme/widgets", "acme/tools"],
		state: "open",
	};
	expect(await schema["~standard"].validate(input)).toEqual({ value: input });
	expect(
		(await schema["~standard"].validate({ query: "fix", repos: [] })).issues,
	).toBeDefined();
	expect(
		(await schema["~standard"].validate({ ...input, state: "merged" })).issues,
	).toBeDefined();
});

test("repositories exposes identities without local paths", async () => {
	const schema = contract.pullRequests.repositories["~orpc"].outputSchemas[0];
	expect(schema).toBeDefined();
	if (schema === undefined) return;
	const repositories = [{ owner: "acme", repo: "widgets" }];
	expect(await schema["~standard"].validate(repositories)).toEqual({
		value: repositories,
	});
	expect(
		(await schema["~standard"].validate([{ owner: "acme" }])).issues,
	).toBeDefined();
});
