import { expect, test } from "bun:test";
import { formatTimeline } from "./measure-launch-format.ts";

test("sorts wall clocks, identifies warm boot and prints waterfall durations", () => {
	const result = formatTimeline([
		{ at: 100, source: "cli", name: "cli.process-start" },
		{
			at: 130,
			source: "sidecar",
			name: "spawn",
			command: "gh",
			args: ["pr", "view"],
			durationMs: 20,
		},
		{ at: 50, source: "sidecar", name: "sidecar.router.ready" },
		{ at: 160, source: "frontend", name: "tab.content.painted", tab: "files" },
		{ at: 161, source: "frontend", name: "trace.done" },
	]);
	expect(result).toContain("sidecar.router.ready: -50.0 ms (warm)");
	expect(result).toContain("tab.content.painted: 60.0 ms");
	expect(result).toContain('20.0 gh ["pr","view"]');
	expect(result).toEndWith("Complete");
});

test("does not invent an origin or claim incomplete traces succeeded", () => {
	expect(formatTimeline([])).toContain("Missing cli.process-start");
	expect(
		formatTimeline([{ at: 1, source: "cli", name: "cli.process-start" }]),
	).toContain("INCOMPLETE");
});
