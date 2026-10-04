import { expect, spyOn, test } from "bun:test";
import type { SidecarClient } from "@repo/sidecar-api";
import { launchMark, receiveTracedOpen } from "./launch-trace";

test("a rejected mark batch warns without blocking terminal delivery", async () => {
	const failure = new Error("sidecar unavailable");
	const warned = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const batches: string[][] = [];
	const warn = spyOn(console, "warn").mockImplementation(() =>
		warned.resolve(),
	);
	const client: Pick<SidecarClient, "diagnostics"> = {
		diagnostics: {
			launchMarks: async (input) => {
				batches.push(input.marks.map((mark) => mark.name));
				if (batches.length === 1) throw failure;
				delivered.resolve();
			},
		},
	};
	try {
		receiveTracedOpen(
			{
				id: "request",
				traceId: "delivery-recovery",
				cwd: "/worktree",
				target: "auto",
				status: { kind: "pending" },
			},
			client,
		);
		await warned.promise;
		launchMark("overview.content.painted", { tab: "overview" });
		await delivered.promise;
		expect(warn).toHaveBeenCalledWith("Launch trace delivery failed", failure);
		expect(batches).toHaveLength(2);
		expect(batches[1]).toEqual([
			"overview.content.painted",
			"tab.content.painted",
			"trace.done",
		]);
	} finally {
		warn.mockRestore();
	}
});
