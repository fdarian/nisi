import { expect, test } from "bun:test";
import type { SidecarClient } from "@repo/sidecar-api";
import {
	launchMark,
	receiveTracedDeepLink,
	resolveTracedDeepLink,
} from "#/infra/launch-trace";
import { dequeueDeepLink, enqueueInjectedDeepLink } from "./deep-link-store";

test("injected queue entries preserve the trace and dedupe reconnect replays through terminal session paint", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", {
		configurable: true,
		value: Object.assign(new EventTarget(), { hidden: false }),
	});
	const names: string[] = [];
	const done = Promise.withResolvers<void>();
	const client: {
		diagnostics: Pick<SidecarClient["diagnostics"], "launchMarks">;
	} = {
		diagnostics: {
			launchMarks: async (input) => {
				names.push(...input.marks.map((mark) => mark.name));
				if (names.includes("trace.done")) done.resolve();
			},
		},
	};
	try {
		receiveTracedDeepLink("injected-trace", client);
		expect(
			enqueueInjectedDeepLink("nisi://open?url=test", "injected-trace"),
		).toBe(true);
		expect(
			enqueueInjectedDeepLink("nisi://open?url=test", "injected-trace"),
		).toBe(false);
		expect(dequeueDeepLink()).toEqual({
			url: "nisi://open?url=test",
			traceId: "injected-trace",
		});
		launchMark("deeplink.dequeued");
		resolveTracedDeepLink("injected-trace", "session");
		launchMark("files.first-diff.painted", {
			sessionId: "other",
			tab: "files",
		});
		launchMark("files.list.painted", { sessionId: "session" });
		launchMark("files.first-diff.painted", {
			sessionId: "session",
			tab: "files",
		});
		await done.promise;
		expect(names).toContain("deeplink.received");
		expect(names).toContain("pull-requests.open.resolved");
		expect(
			names.filter((name) => name === "files.first-diff.painted"),
		).toHaveLength(1);
		expect(names).not.toContain("open-requested.received");
	} finally {
		if (previous === undefined) Reflect.deleteProperty(globalThis, "document");
		else Object.defineProperty(globalThis, "document", previous);
	}
});
