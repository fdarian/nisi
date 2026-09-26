import { describe, expect, test } from "bun:test";
import {
	demandedFileContentChunks,
	FILE_CONTENTS_CHUNK_SIZE,
} from "./file-content-demand";

const paths = Array.from(
	{ length: FILE_CONTENTS_CHUNK_SIZE * 4 + 1 },
	(_, index) => `file-${index}`,
);

describe("demandedFileContentChunks", () => {
	test("demands the first chunk before a rendered-window report, plus the selection", () => {
		expect([
			...demandedFileContentChunks(paths, null, "file-95", false),
		]).toEqual([0, 3]);
		expect([...demandedFileContentChunks(paths, null, null, false)]).toEqual([
			0,
		]);
		expect([...demandedFileContentChunks([], null, null, false)]).toEqual([]);
		expect([...demandedFileContentChunks(paths, [], null, false)]).toEqual([]);
	});

	test("demands rendered chunks and one chunk after the last rendered item", () => {
		expect([
			...demandedFileContentChunks(
				paths,
				["file-29", "file-30", "file-59"],
				null,
				false,
			),
		]).toEqual([0, 1, 2]);
	});

	test("does not look ahead past the final chunk", () => {
		expect([
			...demandedFileContentChunks(paths, ["file-120"], null, false),
		]).toEqual([4]);
	});

	test("demands a selected offscreen file even with no rendered items", () => {
		expect([...demandedFileContentChunks(paths, [], "file-95", false)]).toEqual(
			[3],
		);
	});

	test("ignores binary or filtered-out paths absent from the fixed list", () => {
		expect([
			...demandedFileContentChunks(paths, ["missing"], "missing", false),
		]).toEqual([]);
	});

	test("keyword search demands all chunks, including a partial last chunk", () => {
		expect([...demandedFileContentChunks(paths, [], null, true)]).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect([...demandedFileContentChunks([], [], null, true)]).toEqual([]);
	});

	test("the same path stays in the same chunk regardless of rendered window", () => {
		expect([
			...demandedFileContentChunks(paths, ["file-31"], null, false),
		]).toEqual([1, 2]);
		expect([...demandedFileContentChunks(paths, [], "file-31", false)]).toEqual(
			[1],
		);
	});
});
