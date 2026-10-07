import { expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Logger, Schema } from "effect";
import { launchTracePath, makeLaunchTracer } from "../src/launch-tracer.ts";

const records = (dir: string, id: string) =>
	Effect.runSync(
		Schema.decodeUnknownEffect(
			Schema.fromJsonString(
				Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
			),
		)(
			`[${readFileSync(launchTracePath(dir, id), "utf8").trim().split("\n").join(",")}]`,
		),
	);
const scratch = () => mkdtempSync(join(tmpdir(), "nisi-tracer-"));

test("inactive output is empty; first activation flushes only boot with nesting", () => {
	const dir = scratch();
	try {
		Effect.runSync(
			Effect.gen(function* () {
				const exporter = yield* makeLaunchTracer({
					dataDir: dir,
					source: "sidecar",
				});
				yield* Effect.void.pipe(
					Effect.withSpan("unrelated"),
					Effect.withTracer(exporter.tracer),
				);
				yield* Effect.void.pipe(
					Effect.withSpan("sidecar.router.attach"),
					Effect.withSpan("sidecar.boot"),
					Effect.withTracer(exporter.tracer),
				);
				expect(existsSync(join(dir, "logs"))).toBe(false);
				yield* exporter.activate("first");
				yield* Effect.void.pipe(
					Effect.withSpan("child"),
					Effect.withSpan("sessions.open"),
					Effect.withTracer(exporter.tracer),
				);
				yield* exporter.deactivate();
				yield* exporter.activate("second");
			}),
		);
		const first = records(dir, "first");
		expect(first.map((record) => record.name)).toEqual([
			"sidecar.router.attach",
			"sidecar.boot",
			"child",
			"sessions.open",
		]);
		expect(first[0]?.parentSpanId).toBe(first[1]?.spanId);
		expect(first[2]?.parentSpanId).toBe(first[3]?.spanId);
		expect(existsSync(launchTracePath(dir, "second"))).toBe(false);
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("span start/end and event timestamps use Date.now, including clock jumps", () => {
	const dir = scratch();
	const wall = spyOn(Date, "now").mockReturnValue(10_000);
	try {
		Effect.runSync(
			Effect.gen(function* () {
				const exporter = yield* makeLaunchTracer({
					dataDir: dir,
					source: "cli",
				});
				yield* exporter.activate("clock");
				yield* Effect.gen(function* () {
					wall.mockReturnValue(20_000);
					const current = yield* Effect.currentSpan.pipe(Effect.orDie);
					current.event("milestone", 0n, { hidden: false });
					wall.mockReturnValue(30_000);
				}).pipe(
					Effect.withSpan("operation"),
					Effect.withTracer(exporter.tracer),
				);
			}),
		);
		expect(records(dir, "clock")).toMatchObject([
			{ type: "mark", at: 20_000, attrs: { hidden: false } },
			{ type: "span", start: 10_000, end: 30_000 },
		]);
	} finally {
		wall.mockRestore();
		rmSync(dir, { recursive: true });
	}
});

test("write failure warns through the ambient logger and never fails work", () => {
	const dir = scratch();
	writeFileSync(join(dir, "logs"), "not a directory");
	const warnings: unknown[] = [];
	try {
		const result = Effect.runSync(
			Effect.gen(function* () {
				const exporter = yield* makeLaunchTracer({
					dataDir: dir,
					source: "cli",
				});
				yield* exporter.activate("broken");
				return yield* Effect.succeed("work completed").pipe(
					Effect.withSpan("operation"),
					Effect.withTracer(exporter.tracer),
				);
			}).pipe(
				Effect.provide(
					Logger.layer([
						Logger.make((options) => {
							warnings.push(options.message);
						}),
					]),
				),
			),
		);
		expect(result).toBe("work completed");
		expect(warnings).toHaveLength(1);
		expect(String(warnings[0])).toContain("Launch trace write failed");
	} finally {
		rmSync(dir, { recursive: true });
	}
});

test("deadline and replacement prevent stale spans leaking into the next trace", () => {
	const dir = scratch();
	const wall = spyOn(Date, "now").mockReturnValue(1000);
	try {
		Effect.runSync(
			Effect.gen(function* () {
				const exporter = yield* makeLaunchTracer({
					dataDir: dir,
					source: "sidecar",
				});
				yield* exporter.activate("old");
				yield* Effect.gen(function* () {
					yield* exporter.activate("new");
				}).pipe(
					Effect.withSpan("old-work"),
					Effect.withTracer(exporter.tracer),
				);
				wall.mockReturnValue(61_001);
				yield* Effect.void.pipe(
					Effect.withSpan("expired"),
					Effect.withTracer(exporter.tracer),
				);
				expect(exporter.activeId()).toBeUndefined();
			}),
		);
		expect(existsSync(join(dir, "logs"))).toBe(false);
	} finally {
		wall.mockRestore();
		rmSync(dir, { recursive: true });
	}
});
