import { expect, test } from "bun:test";
import { ORPCError } from "@orpc/client";
import {
	mergeStatusRetryDelay,
	retryDisconnectedLiveQuery,
	retryMergeStatusQuery,
} from "./pr-data";

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

test("merge status also retries SERVICE_UNAVAILABLE without a cap", () => {
	const closed = new Error("WebSocket closed (code 1006: )");
	closed.name = "AbortError";
	expect(retryMergeStatusQuery(1, closed)).toBe(true);
	expect(retryMergeStatusQuery(500, new ORPCError("SERVICE_UNAVAILABLE"))).toBe(
		true,
	);
	expect(retryMergeStatusQuery(1, new ORPCError("UNAUTHORIZED"))).toBe(false);
	expect(retryMergeStatusQuery(1, new Error("network error"))).toBe(false);
});

test("merge status retry delay doubles from 1s and caps at 60s", () => {
	expect(mergeStatusRetryDelay(0)).toBe(1000);
	expect(mergeStatusRetryDelay(1)).toBe(2000);
	expect(mergeStatusRetryDelay(5)).toBe(32_000);
	expect(mergeStatusRetryDelay(6)).toBe(60_000);
	expect(mergeStatusRetryDelay(1000)).toBe(60_000);
});
