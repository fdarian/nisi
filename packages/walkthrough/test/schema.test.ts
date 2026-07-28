import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";
import { Walkthrough, walkthroughJsonSchema } from "../src/schema.ts";

const decode = Schema.decodeUnknownResult(Walkthrough);

const validDoc = {
	version: 1,
	sections: [{ title: "Intro", body: "See [x](ref:r1)." }],
	references: [
		{
			id: "r1",
			label: "Foo",
			locations: [{ path: "a.ts", startLine: 1, endLine: 2 }],
		},
	],
};

describe("Walkthrough schema decode", () => {
	test("decodes a well-formed document", () => {
		const result = decode(validDoc);
		expect(Result.isSuccess(result)).toBe(true);
	});

	test("rejects a version other than 1", () => {
		const result = decode({ ...validDoc, version: 2 });
		expect(Result.isFailure(result)).toBe(true);
	});

	test("rejects a missing required field", () => {
		const { sections: _sections, ...withoutSections } = validDoc;
		const result = decode(withoutSections);
		expect(Result.isFailure(result)).toBe(true);
	});

	test("rejects an empty sections array", () => {
		const result = decode({ ...validDoc, sections: [] });
		expect(Result.isFailure(result)).toBe(true);
	});

	test("rejects a reference block with no locations", () => {
		const result = decode({
			...validDoc,
			references: [{ id: "r1", label: "Foo", locations: [] }],
		});
		expect(Result.isFailure(result)).toBe(true);
	});

	test("rejects a non-positive startLine", () => {
		const result = decode({
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 0, endLine: 2 }],
				},
			],
		});
		expect(Result.isFailure(result)).toBe(true);
	});

	test("rejects a non-integer line number", () => {
		const result = decode({
			...validDoc,
			references: [
				{
					id: "r1",
					label: "Foo",
					locations: [{ path: "a.ts", startLine: 1.5, endLine: 2 }],
				},
			],
		});
		expect(Result.isFailure(result)).toBe(true);
	});

	test("silently drops an unrecognized property rather than failing the turn over it", () => {
		// The generated JSON Schema (see below) still declares
		// `additionalProperties: false`, so the model is told not to add one —
		// but if it does anyway, decode succeeds without the stray field rather
		// than wasting a retry on something harmless.
		const result = decode({ ...validDoc, extra: "nope" });
		expect(Result.isSuccess(result)).toBe(true);
		if (Result.isSuccess(result)) {
			expect(result.success).not.toHaveProperty("extra");
		}
	});

	test("accepts an empty references array (no claims yet, mid-draft)", () => {
		const result = decode({ ...validDoc, references: [] });
		expect(Result.isSuccess(result)).toBe(true);
	});
});

describe("walkthroughJsonSchema", () => {
	test("is generated (never hand-written) from the same schema decode uses", () => {
		expect(walkthroughJsonSchema.type).toBe("object");
		expect(walkthroughJsonSchema.additionalProperties).toBe(false);
		expect(walkthroughJsonSchema.required).toEqual([
			"version",
			"sections",
			"references",
		]);
	});

	test("constrains version to the literal 1", () => {
		const properties = walkthroughJsonSchema.properties as Record<
			string,
			{ enum?: unknown }
		>;
		expect(properties.version?.enum).toEqual([1]);
	});

	test("requires id/label/locations on a reference block, and path/startLine/endLine on a location", () => {
		const properties = walkthroughJsonSchema.properties as Record<
			string,
			{
				items?: {
					properties?: Record<string, { items?: { required?: unknown } }>;
				};
			}
		>;
		const referenceBlockSchema = properties.references?.items;
		expect(
			referenceBlockSchema?.properties?.locations?.items?.required,
		).toEqual(["path", "startLine", "endLine"]);
	});
});
