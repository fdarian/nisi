import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTracePath } from "@repo/logging";
import { ConfigProvider, Effect } from "effect";
import { LaunchTrace } from "./service.ts";

test("frontend terminal delivery closes only its active trace", () => {
	const dir = mkdtempSync(join(tmpdir(), "nisi-trace-service-"));
	try {
		Effect.runSync(
			Effect.gen(function* () {
				const trace = yield* LaunchTrace;
				yield* trace.activate("active");
				yield* trace.frontend("stale", [
					{
						type: "mark",
						source: "frontend",
						at: 1,
						name: "trace.done",
						attrs: {},
					},
				]);
				expect(trace.exporter.activeId()).toBe("active");
				yield* trace.frontend("active", [
					{
						type: "mark",
						source: "frontend",
						at: 2,
						name: "frontend.visibility",
						attrs: { hidden: true },
					},
					{
						type: "mark",
						source: "frontend",
						at: 3,
						name: "trace.done",
						attrs: {},
					},
				]);
				expect(trace.exporter.activeId()).toBeUndefined();
			}).pipe(
				Effect.provide(LaunchTrace.layer),
				Effect.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({ NISI_DATA_DIR: dir }),
					),
				),
			),
		);
		expect(readFileSync(launchTracePath(dir, "active"), "utf8")).toContain(
			'"hidden":true',
		);
	} finally {
		rmSync(dir, { recursive: true });
	}
});
