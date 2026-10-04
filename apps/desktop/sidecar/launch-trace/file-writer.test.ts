import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLaunchMarks, traceFilePath } from "./file-writer.ts";

test("appends complete JSONL batches without overwriting another source", () => {
	const directory = mkdtempSync(join(tmpdir(), "nisi-launch-writer-"));
	try {
		appendLaunchMarks(directory, "run-1", [
			{ at: 1.25, source: "cli", name: "cli.main" },
		]);
		appendLaunchMarks(directory, "run-1", [
			{ at: 2.5, source: "frontend", name: "trace.done" },
		]);
		expect(readFileSync(traceFilePath(directory, "run-1"), "utf8")).toBe(
			'{"at":1.25,"source":"cli","name":"cli.main"}\n{"at":2.5,"source":"frontend","name":"trace.done"}\n',
		);
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("rejects IDs that could escape the trace directory", () => {
	for (const id of ["../escape", "", "a/b", "a".repeat(129)])
		expect(() => traceFilePath("/scratch", id)).toThrow(
			"Invalid launch trace ID",
		);
});
