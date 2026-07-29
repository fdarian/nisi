import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { GenerateEvent } from "@repo/sidecar-api";
import {
	attachToGeneration,
	beginGeneration,
	clearGeneration,
	getGeneration,
	recordGenerationEvent,
} from "../generation-log.ts";

/** A fresh sessionId per test — `generation-log.ts`'s state is one shared module-level `Map`, so tests isolate by key instead of resetting it. */
const sessionId = () => randomUUID();

describe("generation-log", () => {
	test("getGeneration is undefined before any generation has begun", () => {
		expect(getGeneration(sessionId())).toBeUndefined();
	});

	test("attachToGeneration is undefined when nothing has been retained", () => {
		const id = sessionId();
		const received: Array<GenerateEvent> = [];
		expect(
			attachToGeneration(id, (event) => received.push(event)),
		).toBeUndefined();
		expect(received).toEqual([]);
	});

	test("a subscriber attached before any events replays nothing, then follows live ones", () => {
		const id = sessionId();
		beginGeneration(id, "codex", "gpt-5.1-codex");

		const received: Array<GenerateEvent> = [];
		const unsubscribe = attachToGeneration(id, (event) => received.push(event));
		expect(unsubscribe).toBeDefined();

		recordGenerationEvent(id, { type: "bootstrapping" });
		recordGenerationEvent(id, { type: "turn-started", turn: 1 });

		expect(received).toEqual([
			{ type: "bootstrapping" },
			{ type: "turn-started", turn: 1 },
		]);

		unsubscribe?.();
	});

	test("a subscriber attaching mid-generation replays the backlog, then follows live ones — the tab-switch-and-back scenario", () => {
		const id = sessionId();
		beginGeneration(id, "claude-code", undefined);
		recordGenerationEvent(id, { type: "bootstrapping" });
		recordGenerationEvent(id, { type: "turn-started", turn: 1 });
		recordGenerationEvent(id, {
			type: "tool-call",
			turn: 1,
			toolName: "write",
		});

		// Simulates disconnecting and resubscribing: a fresh subscriber attaches
		// only now, after three events already happened without it.
		const received: Array<GenerateEvent> = [];
		const unsubscribe = attachToGeneration(id, (event) => received.push(event));

		expect(received).toEqual([
			{ type: "bootstrapping" },
			{ type: "turn-started", turn: 1 },
			{ type: "tool-call", turn: 1, toolName: "write" },
		]);

		// Events recorded after attaching arrive live, appended to the same feed.
		recordGenerationEvent(id, {
			type: "validation-failed",
			turn: 1,
			feedback: "missing coverage",
		});
		expect(received).toHaveLength(4);
		expect(received[3]).toEqual({
			type: "validation-failed",
			turn: 1,
			feedback: "missing coverage",
		});

		unsubscribe?.();
	});

	test("multiple concurrent subscribers each get the full backlog plus their own live feed", () => {
		const id = sessionId();
		beginGeneration(id, "opencode", "anthropic/claude-sonnet-4-5");
		recordGenerationEvent(id, { type: "bootstrapping" });

		const a: Array<GenerateEvent> = [];
		const b: Array<GenerateEvent> = [];
		const unsubA = attachToGeneration(id, (event) => a.push(event));
		const unsubB = attachToGeneration(id, (event) => b.push(event));

		recordGenerationEvent(id, { type: "turn-started", turn: 1 });

		expect(a).toEqual([
			{ type: "bootstrapping" },
			{ type: "turn-started", turn: 1 },
		]);
		expect(b).toEqual(a);

		unsubA?.();
		unsubB?.();
	});

	test("unsubscribing stops further live delivery without affecting the retained log", () => {
		const id = sessionId();
		beginGeneration(id, "pi", undefined);
		const received: Array<GenerateEvent> = [];
		const unsubscribe = attachToGeneration(id, (event) => received.push(event));
		unsubscribe?.();

		recordGenerationEvent(id, { type: "bootstrapping" });
		expect(received).toEqual([]);
		expect(getGeneration(id)?.events).toEqual([{ type: "bootstrapping" }]);
	});

	test("status tracks the last recorded event's terminal type", () => {
		const id = sessionId();
		beginGeneration(id, "codex", undefined);
		expect(getGeneration(id)?.status).toBe("running");

		recordGenerationEvent(id, { type: "turn-started", turn: 1 });
		expect(getGeneration(id)?.status).toBe("running");

		recordGenerationEvent(id, { type: "failed", message: "boom" });
		expect(getGeneration(id)?.status).toBe("failed");
	});

	test("a completed generation is not reattachable — the next generate call for the session starts fresh", () => {
		const id = sessionId();
		beginGeneration(id, "codex", undefined);
		recordGenerationEvent(id, {
			type: "failed",
			message: "coverage never converged",
		});

		expect(attachToGeneration(id, () => {})).toBeUndefined();
		// But the finished generation is still readable directly — a late
		// visitor to the walkthrough tab still learns what happened.
		expect(getGeneration(id)).toEqual({
			harness: "codex",
			model: null,
			events: [{ type: "failed", message: "coverage never converged" }],
			status: "failed",
		});
	});

	test("beginGeneration discards a previous generation's retained log", () => {
		const id = sessionId();
		beginGeneration(id, "codex", undefined);
		recordGenerationEvent(id, {
			type: "done",
			walkthrough: doneWalkthrough(id),
		});
		expect(getGeneration(id)?.status).toBe("done");

		beginGeneration(id, "claude-code", "sonnet");
		expect(getGeneration(id)).toEqual({
			harness: "claude-code",
			model: "sonnet",
			events: [],
			status: "running",
		});
	});

	test("clearGeneration removes the retained state entirely", () => {
		const id = sessionId();
		beginGeneration(id, "codex", undefined);
		recordGenerationEvent(id, { type: "bootstrapping" });
		clearGeneration(id);
		expect(getGeneration(id)).toBeUndefined();
		expect(attachToGeneration(id, () => {})).toBeUndefined();
	});

	test("recording against a session with nothing begun is a safe no-op", () => {
		const id = sessionId();
		expect(() =>
			recordGenerationEvent(id, { type: "bootstrapping" }),
		).not.toThrow();
		expect(getGeneration(id)).toBeUndefined();
	});
});

const doneWalkthrough = (id: string) =>
	({
		sessionId: id,
		harness: "codex" as const,
		model: null,
		walkthrough: { version: 1 as const, sections: [], references: [] },
		fingerprints: {},
		generatedAt: Date.now(),
	}) satisfies Extract<GenerateEvent, { type: "done" }>["walkthrough"];
