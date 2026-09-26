import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import { retryDisconnectedLiveQuery } from "./pr-data";

test("retries socket disconnects, not sidecar or unrelated abort errors", () => {
	const closed = new Error("WebSocket closed (code 1006: )");
	closed.name = "AbortError";
	const reconnectFailed = new Error(
		"WebSocket reconnect failed after 3 attempt(s)",
	);
	reconnectFailed.name = "AbortError";
	const cancelled = new Error("The request was aborted");
	cancelled.name = "AbortError";
	expect(retryDisconnectedLiveQuery(1, closed)).toBe(true);
	expect(retryDisconnectedLiveQuery(20, reconnectFailed)).toBe(true);
	expect(retryDisconnectedLiveQuery(1, cancelled)).toBe(false);
	expect(retryDisconnectedLiveQuery(1, new ORPCError("UNAUTHORIZED"))).toBe(
		false,
	);
	expect(retryDisconnectedLiveQuery(1, new Error("network error"))).toBe(false);
});
