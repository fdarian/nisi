import { describe, expect, spyOn, test } from "bun:test";
import { emit, streamReady, subscribe } from "../events.ts";
import {
	acknowledgeActivation,
	acknowledgeOpenRequest,
	createOpenRequest,
	failOpenRequest,
	listOpenRequests,
	resolveOpenRequest,
	subscribeToActivations,
} from "../open-requests.ts";

const target = { kind: "auto" } as const;
const session = {
	id: "session-1",
	repoRoot: "/repo",
	target: { kind: "branch", baseRef: "main", headRef: "feature" },
} as const;

describe("open requests", () => {
	test("replays a request and its result to a late subscriber until acknowledged", () => {
		const request = createOpenRequest("/repo", target);
		resolveOpenRequest(request.id, session);
		const observed: string[] = [];
		const stop = subscribeToActivations((id) => observed.push(id));
		expect(observed).toContain(request.id);
		expect(
			listOpenRequests().find((entry) => entry.id === request.id)?.status,
		).toEqual({ kind: "opened", session });
		acknowledgeOpenRequest(request.id);
		expect(listOpenRequests().some((entry) => entry.id === request.id)).toBe(
			false,
		);
		stop();
		const afterAck: string[] = [];
		const stopAfterAck = subscribeToActivations((id) => afterAck.push(id));
		expect(afterAck).toContain(request.id);
		acknowledgeActivation(request.id);
		stopAfterAck();
		const afterActivation: string[] = [];
		const stopAfterActivation = subscribeToActivations((id) =>
			afterActivation.push(id),
		);
		expect(afterActivation).not.toContain(request.id);
		stopAfterActivation();
	});

	test("repeat opens emit separate ordered events even for the same session", () => {
		const seen: Array<{ type: string; seq: number; id: string }> = [];
		const stop = subscribe((event) => {
			if (event.type === "open-requested" || event.type === "open-resolved") {
				seen.push({ type: event.type, seq: event.seq, id: event.request.id });
			}
		});
		const first = createOpenRequest("/repo", target);
		resolveOpenRequest(first.id, session);
		const second = createOpenRequest("/repo", target);
		resolveOpenRequest(second.id, session);
		stop();
		expect(first.id).not.toBe(second.id);
		expect(seen.map((entry) => entry.type)).toEqual([
			"open-requested",
			"open-resolved",
			"open-requested",
			"open-resolved",
		]);
		seen.reduce<number | undefined>((previous, entry) => {
			if (previous !== undefined) expect(entry.seq).toBeGreaterThan(previous);
			return entry.seq;
		}, undefined);
		expect(seen.map((entry) => entry.id)).toEqual([
			first.id,
			first.id,
			second.id,
			second.id,
		]);
		for (const request of [first, second]) {
			acknowledgeOpenRequest(request.id);
			acknowledgeActivation(request.id);
		}
	});

	test("failure is retained, ready markers preserve sequence", () => {
		const before = streamReady();
		const request = createOpenRequest("/repo", target);
		const ready = streamReady();
		failOpenRequest(request.id, "GitHub unavailable");
		const after = emit({ type: "session-opened", session });
		expect(before.seq).toBeLessThan(ready.seq);
		expect(ready.seq).toBeLessThan(after.seq);
		expect(
			listOpenRequests().find((entry) => entry.id === request.id)?.status,
		).toEqual({ kind: "failed", message: "GitHub unavailable" });
		acknowledgeOpenRequest(request.id);
		acknowledgeActivation(request.id);
	});

	test("bounds unacknowledged terminal requests and activation replay", () => {
		const created = Array.from({ length: 105 }, () => {
			const request = createOpenRequest("/repo", target);
			failOpenRequest(request.id, "unavailable");
			return request;
		});
		const retained = listOpenRequests();
		expect(retained).toHaveLength(100);
		expect(retained[0]?.id).toBe(created[5]?.id);
		const replayed: string[] = [];
		const stop = subscribeToActivations((id) => replayed.push(id));
		expect(replayed).toHaveLength(100);
		expect(replayed[0]).toBe(created[5]?.id);
		stop();
		for (const request of created) {
			acknowledgeOpenRequest(request.id);
			acknowledgeActivation(request.id);
		}
	});

	test("expires settled requests and unacknowledged activations", () => {
		let now = 1_000;
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const request = createOpenRequest("/repo", target);
			failOpenRequest(request.id, "unavailable");
			now += 30 * 60_000;
			expect(listOpenRequests().some((entry) => entry.id === request.id)).toBe(
				false,
			);
			const replayed: string[] = [];
			const stop = subscribeToActivations((id) => replayed.push(id));
			expect(replayed).not.toContain(request.id);
			stop();
		} finally {
			clock.mockRestore();
		}
	});
});
