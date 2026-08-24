import { describe, expect, test } from "bun:test";
import { applyTabOrder, parseTabOrder } from "./tab-order.ts";

function session(id: string): { id: string } {
	return { id };
}

describe("applyTabOrder", () => {
	test("returns the incoming sessions when no order has been stored", () => {
		const sessions = [session("b"), session("a")];
		expect(applyTabOrder(sessions, [])).toEqual(sessions);
		expect(applyTabOrder(sessions, [])).not.toBe(sessions);
	});

	test("reorders open sessions to match the stored ids", () => {
		expect(
			applyTabOrder(
				[session("c"), session("a"), session("b")],
				["a", "b", "c"],
			),
		).toEqual([session("a"), session("b"), session("c")]);
	});

	test("drops stored ids that are no longer open", () => {
		expect(
			applyTabOrder([session("a"), session("c")], ["a", "b", "c"]),
		).toEqual([session("a"), session("c")]);
	});

	test("appends newly opened sessions after the stored ones, keeping their incoming order", () => {
		expect(
			applyTabOrder(
				[session("d"), session("e"), session("b"), session("a")],
				["a", "b"],
			),
		).toEqual([session("a"), session("b"), session("d"), session("e")]);
	});
});

describe("parseTabOrder", () => {
	test("reads a JSON array of session ids", () => {
		expect(parseTabOrder('["a","b"]')).toEqual(["a", "b"]);
	});

	test("rejects a non-array", () => {
		expect(() => parseTabOrder('{"a":1}')).toThrow(
			"tab order must be a JSON array of session ids",
		);
	});

	test("rejects an array with a non-string entry", () => {
		expect(() => parseTabOrder('["a",1]')).toThrow(
			"tab order must be a JSON array of session ids",
		);
	});
});
