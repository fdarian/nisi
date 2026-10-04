import { expect, spyOn, test } from "bun:test";
import type { SidecarClient } from "@repo/sidecar-api";
import { launchMark, receiveTracedOpen } from "./launch-trace";

test("a rejected mark batch warns without blocking terminal delivery", async () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: Object.assign(new EventTarget(), { hidden: false }),
	});
	const failure = new Error("sidecar unavailable");
	const warned = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	const batches: string[][] = [];
	const terminalTimestamps: number[] = [];
	const boot: { navigationAt?: number } = {};
	const clock = spyOn(Date, "now").mockReturnValue(1234);
	const warn = spyOn(console, "warn").mockImplementation(() =>
		warned.resolve(),
	);
	const client: Pick<SidecarClient, "diagnostics"> = {
		diagnostics: {
			launchMarks: async (input) => {
				batches.push(input.marks.map((mark) => mark.name));
				if (batches.length === 1) {
					boot.navigationAt = input.marks.find(
						(mark) => mark.name === "frontend.navigation-start",
					)?.at;
					throw failure;
				}
				terminalTimestamps.push(...input.marks.map((mark) => mark.at));
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
				target: { kind: "auto" },
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
		expect(terminalTimestamps).toEqual([1234, 1234, 1234]);
		expect(boot.navigationAt).toBe(performance.timeOrigin);
	} finally {
		clock.mockRestore();
		warn.mockRestore();
		if (previousDocument === undefined)
			Reflect.deleteProperty(globalThis, "document");
		else Object.defineProperty(globalThis, "document", previousDocument);
	}
});

test("records initial visibility and every transition only during the active trace", async () => {
	const previousDocument = Object.getOwnPropertyDescriptor(
		globalThis,
		"document",
	);
	const document = Object.assign(new EventTarget(), { hidden: true });
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: document,
	});
	const delivered = Promise.withResolvers<void>();
	const visibility: boolean[] = [];
	const client: Pick<SidecarClient, "diagnostics"> = {
		diagnostics: {
			launchMarks: async (input) => {
				for (const mark of input.marks)
					if (
						mark.name === "frontend.visibility" &&
						typeof mark.attrs.hidden === "boolean"
					)
						visibility.push(mark.attrs.hidden);
				if (input.marks.some((mark) => mark.name === "trace.done"))
					delivered.resolve();
			},
		},
	};
	try {
		receiveTracedOpen(
			{
				id: "visibility-request",
				traceId: "visibility-trace",
				cwd: "/worktree",
				target: { kind: "auto" },
				status: { kind: "pending" },
			},
			client,
		);
		document.hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
		document.hidden = true;
		document.dispatchEvent(new Event("visibilitychange"));
		launchMark("tab.content.painted");
		await delivered.promise;
		document.hidden = false;
		document.dispatchEvent(new Event("visibilitychange"));
		expect(visibility).toEqual([true, false, true]);
	} finally {
		if (previousDocument === undefined)
			Reflect.deleteProperty(globalThis, "document");
		else Object.defineProperty(globalThis, "document", previousDocument);
	}
});
