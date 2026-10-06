import { expect, test } from "bun:test";
import type { SidecarClient } from "@repo/sidecar-api";
import { receiveTracedOpen } from "#/infra/launch-trace";
import { FilesChangedLoading } from "./files-changed-loading";

test("the shared pending/session skeleton records one loading paint per traced open", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: Object.assign(new EventTarget(), { hidden: false }),
	});
	const frames: FrameRequestCallback[] = [];
	const previousFrame = Object.getOwnPropertyDescriptor(
		globalThis,
		"requestAnimationFrame",
	);
	Object.defineProperty(globalThis, "requestAnimationFrame", {
		configurable: true,
		value: (callback: FrameRequestCallback) => {
			frames.push(callback);
			return frames.length;
		},
	});
	const delivered = Promise.withResolvers<void>();
	const names: string[] = [];
	const client: {
		diagnostics: Pick<SidecarClient["diagnostics"], "launchMarks">;
	} = {
		diagnostics: {
			launchMarks: async (input) => {
				names.push(...input.marks.map((mark) => mark.name));
				if (names.includes("files.loading.painted")) delivered.resolve();
			},
		},
	};
	const node = {
		isConnected: true,
		getBoundingClientRect: () => ({ height: 100 }),
	} as HTMLElement;
	const paint = (props: Parameters<typeof FilesChangedLoading>[0]) => {
		const ref = FilesChangedLoading(props).props.ref;
		if (typeof ref !== "function") throw new Error("Skeleton has no paint ref");
		ref(node);
		for (const callback of frames.splice(0)) callback(0);
	};
	try {
		const request = {
			id: "skeleton-request",
			traceId: "skeleton-trace",
			cwd: "/repo",
			target: { kind: "auto" } as const,
			status: { kind: "pending" } as const,
		};
		receiveTracedOpen(request, client);
		paint({ when: false });
		paint({ sessionId: "other-session" });
		expect(names).not.toContain("files.loading.painted");
		paint({});
		await delivered.promise;
		const opened = {
			...request,
			status: {
				kind: "opened" as const,
				session: {
					id: "session",
					repoRoot: "/repo",
					target: {
						kind: "branch" as const,
						baseRef: "main",
						headRef: "feature",
					},
				},
			},
		};
		receiveTracedOpen(opened, client);
		paint({ sessionId: "session", when: true });
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			names.filter((name) => name === "files.loading.painted"),
		).toHaveLength(1);
		receiveTracedOpen(
			{ ...opened, id: "second-open", traceId: "second-trace" },
			client,
		);
		paint({ sessionId: "session", when: true });
		paint({});
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(
			names.filter((name) => name === "files.loading.painted"),
		).toHaveLength(2);
	} finally {
		if (previousFrame === undefined)
			Reflect.deleteProperty(globalThis, "requestAnimationFrame");
		else
			Object.defineProperty(globalThis, "requestAnimationFrame", previousFrame);
		if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
		else Object.defineProperty(globalThis, "document", previous);
	}
});
