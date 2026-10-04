import { expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
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

test("a throwing append does not fail the caller", () => {
	const directory = mkdtempSync(join(tmpdir(), "nisi-launch-writer-failure-"));
	try {
		mkdirSync(traceFilePath(directory, "append-failure"), { recursive: true });
		const result = Effect.runSync(
			Effect.sync(() => {
				appendLaunchMarks(directory, "append-failure", [
					{
						at: Date.now(),
						source: "sidecar",
						name: "sidecar.activation.acked",
					},
				]);
				return "real work completed";
			}),
		);
		expect(result).toBe("real work completed");
	} finally {
		rmSync(directory, { recursive: true });
	}
});

test("a directory creation failure does not fail the caller", () => {
	const directory = mkdtempSync(
		join(tmpdir(), "nisi-launch-writer-mkdir-failure-"),
	);
	try {
		const blocked = join(directory, "blocked");
		writeFileSync(blocked, "not a directory");
		const result = Effect.runSync(
			Effect.sync(() => {
				appendLaunchMarks(blocked, "mkdir-failure", []);
				return "real work completed";
			}),
		);
		expect(result).toBe("real work completed");
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
