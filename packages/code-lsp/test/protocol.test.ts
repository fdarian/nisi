import { describe, expect, test } from "bun:test";
import {
	autoResponderResult,
	classifyMessage,
	decodeFrames,
	decodeHover,
	decodeLocations,
	encodeFrame,
	pathToUri,
	uriToPath,
} from "../src/protocol.ts";

describe("encodeFrame / decodeFrames", () => {
	test("round-trips a single message", () => {
		const message = {
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: { a: 1 },
		};
		const { messages, rest } = decodeFrames(encodeFrame(message));
		expect(messages).toEqual([message]);
		expect(rest.length).toBe(0);
	});

	test("counts Content-Length in UTF-8 bytes, not JS string length", () => {
		// "café" is 4 JS chars but 5 UTF-8 bytes ("é" is 2 bytes) — a header
		// built from string length would truncate the body by one byte.
		const message = {
			jsonrpc: "2.0",
			method: "notify",
			params: { text: "café" },
		};
		const frame = encodeFrame(message);
		const header = frame
			.subarray(0, frame.indexOf("\r\n\r\n"))
			.toString("ascii");
		const bodyByteLength = Buffer.byteLength(JSON.stringify(message), "utf8");
		expect(header).toBe(`Content-Length: ${bodyByteLength}`);

		const { messages } = decodeFrames(frame);
		expect(messages).toEqual([message]);
	});

	test("extracts multiple frames concatenated in one buffer", () => {
		const first = { jsonrpc: "2.0", id: 1, result: "a" };
		const second = { jsonrpc: "2.0", id: 2, result: "b" };
		const combined = Buffer.concat([encodeFrame(first), encodeFrame(second)]);

		const { messages, rest } = decodeFrames(combined);
		expect(messages).toEqual([first, second]);
		expect(rest.length).toBe(0);
	});

	test("holds back an incomplete frame until the body fully arrives", () => {
		const message = { jsonrpc: "2.0", id: 1, result: { ok: true } };
		const frame = encodeFrame(message);
		const splitPoint = frame.length - 5;

		const firstChunk = decodeFrames(frame.subarray(0, splitPoint));
		expect(firstChunk.messages).toEqual([]);
		expect(firstChunk.rest.equals(frame.subarray(0, splitPoint))).toBe(true);

		const combined = Buffer.concat([
			firstChunk.rest,
			frame.subarray(splitPoint),
		]);
		const secondChunk = decodeFrames(combined);
		expect(secondChunk.messages).toEqual([message]);
		expect(secondChunk.rest.length).toBe(0);
	});

	test("holds back a header split mid-way across chunks", () => {
		const frame = encodeFrame({ jsonrpc: "2.0", id: 1, result: null });
		const headerEnd = frame.indexOf("\r\n\r\n");
		const midHeader = decodeFrames(frame.subarray(0, headerEnd - 2));
		expect(midHeader.messages).toEqual([]);
		expect(midHeader.rest.length).toBe(headerEnd - 2);
	});

	test("throws on a header that isn't Content-Length", () => {
		const bad = Buffer.from("Bogus-Header: nope\r\n\r\n{}");
		expect(() => decodeFrames(bad)).toThrow();
	});
});

describe("classifyMessage", () => {
	test("a message with id and no method is a response", () => {
		expect(
			classifyMessage({ jsonrpc: "2.0", id: 7, result: { ok: true } }),
		).toEqual({
			kind: "response",
			id: 7,
			result: { ok: true },
		});
	});

	test("a message with id and an error field is an errorResponse", () => {
		const error = { code: -32601, message: "method not found" };
		expect(classifyMessage({ jsonrpc: "2.0", id: 7, error })).toEqual({
			kind: "errorResponse",
			id: 7,
			error,
		});
	});

	test("a message with both id and method is a serverRequest", () => {
		expect(
			classifyMessage({
				jsonrpc: "2.0",
				id: 3,
				method: "client/registerCapability",
				params: { registrations: [] },
			}),
		).toEqual({
			kind: "serverRequest",
			id: 3,
			method: "client/registerCapability",
			params: { registrations: [] },
		});
	});

	test("a message with method and no id is a notification", () => {
		expect(
			classifyMessage({
				jsonrpc: "2.0",
				method: "textDocument/publishDiagnostics",
				params: {},
			}),
		).toEqual({
			kind: "notification",
			method: "textDocument/publishDiagnostics",
			params: {},
		});
	});

	test("throws on a message with neither id nor method", () => {
		expect(() => classifyMessage({ jsonrpc: "2.0" })).toThrow();
	});

	test("throws on a non-object message", () => {
		expect(() => classifyMessage(null)).toThrow();
		expect(() => classifyMessage("nope")).toThrow();
	});
});

describe("autoResponderResult", () => {
	test("workspace/configuration answers one null per requested item", () => {
		expect(
			autoResponderResult("workspace/configuration", {
				items: [{ section: "a" }, { section: "b" }],
			}),
		).toEqual([null, null]);
	});

	test("workspace/configuration with no items answers an empty array", () => {
		expect(autoResponderResult("workspace/configuration", {})).toEqual([]);
	});

	test("client/registerCapability answers null", () => {
		expect(
			autoResponderResult("client/registerCapability", { registrations: [] }),
		).toBeNull();
	});

	test("window/workDoneProgress/create answers null", () => {
		expect(
			autoResponderResult("window/workDoneProgress/create", {}),
		).toBeNull();
	});

	test("an unrecognized server-initiated request still answers null rather than nothing", () => {
		expect(
			autoResponderResult("some/future/method", { anything: true }),
		).toBeNull();
	});
});

describe("pathToUri / uriToPath", () => {
	test("round-trips a plain absolute path", () => {
		const path = "/Users/example/project/src/index.ts";
		expect(uriToPath(pathToUri(path))).toBe(path);
	});

	test("round-trips a path containing spaces", () => {
		const path = "/Users/example/My Project/src/index.ts";
		expect(uriToPath(pathToUri(path))).toBe(path);
	});
});

describe("decodeLocations", () => {
	test("null decodes to an empty array", () => {
		expect(decodeLocations(null)).toEqual([]);
	});

	test("a single Location decodes to a one-element array", () => {
		const uri = pathToUri("/repo/src/a.ts");
		const range = {
			start: { line: 1, character: 2 },
			end: { line: 1, character: 5 },
		};
		expect(decodeLocations({ uri, range })).toEqual([
			{ path: "/repo/src/a.ts", range },
		]);
	});

	test("a Location[] decodes every entry", () => {
		const uriA = pathToUri("/repo/src/a.ts");
		const uriB = pathToUri("/repo/src/b.ts");
		const range = {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		};
		expect(
			decodeLocations([
				{ uri: uriA, range },
				{ uri: uriB, range },
			]),
		).toEqual([
			{ path: "/repo/src/a.ts", range },
			{ path: "/repo/src/b.ts", range },
		]);
	});

	test("a LocationLink prefers targetSelectionRange over targetRange", () => {
		const uri = pathToUri("/repo/src/a.ts");
		const targetRange = {
			start: { line: 0, character: 0 },
			end: { line: 5, character: 0 },
		};
		const targetSelectionRange = {
			start: { line: 1, character: 7 },
			end: { line: 1, character: 12 },
		};
		expect(
			decodeLocations([{ targetUri: uri, targetRange, targetSelectionRange }]),
		).toEqual([{ path: "/repo/src/a.ts", range: targetSelectionRange }]);
	});

	test("throws on a shape with neither uri nor targetUri", () => {
		expect(() => decodeLocations([{ range: {} }])).toThrow();
	});
});

describe("decodeHover", () => {
	test("null decodes to null", () => {
		expect(decodeHover(null)).toBeNull();
	});

	test("plain-string contents decode as-is", () => {
		expect(decodeHover({ contents: "plain text" })).toEqual({
			contents: "plain text",
			range: null,
		});
	});

	test("MarkupContent contents decode to its value", () => {
		expect(
			decodeHover({ contents: { kind: "markdown", value: "**bold**" } }),
		).toEqual({
			contents: "**bold**",
			range: null,
		});
	});

	test("an array of contents joins with a blank line", () => {
		expect(decodeHover({ contents: ["one", { value: "two" }] })).toEqual({
			contents: "one\n\ntwo",
			range: null,
		});
	});

	test("carries range through when present", () => {
		const range = {
			start: { line: 4, character: 1 },
			end: { line: 4, character: 9 },
		};
		expect(decodeHover({ contents: "x", range })).toEqual({
			contents: "x",
			range,
		});
	});

	test("throws on an unrecognized contents shape", () => {
		expect(() => decodeHover({ contents: 42 })).toThrow();
	});
});
