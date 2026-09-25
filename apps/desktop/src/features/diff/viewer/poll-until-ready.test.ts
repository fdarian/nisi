import { afterEach, beforeEach, expect, test } from "bun:test";
import { pollUntilReady } from "./diff-match-dom";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;

beforeEach(() => {
	frames.clear();
	nextFrame = 0;
	globalThis.requestAnimationFrame = (callback) => {
		const id = ++nextFrame;
		frames.set(id, callback);
		return id;
	};
	globalThis.cancelAnimationFrame = (id) => {
		frames.delete(id);
	};
});

afterEach(() => {
	globalThis.requestAnimationFrame = originalRequestAnimationFrame;
	globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
});

function runNextFrame(): void {
	const next = frames.entries().next().value;
	if (next === undefined) throw new Error("No pending animation frame");
	frames.delete(next[0]);
	next[1](0);
}

test("keeps the previous anchor until the new range paints", () => {
	const frameRef = { current: null as number | null };
	let anchor = "previous";
	let painted = false;
	pollUntilReady(
		() => {
			if (!painted) return false;
			anchor = "new";
			return true;
		},
		frameRef,
		2,
		() => {
			anchor = "hidden";
		},
	);
	expect(anchor).toBe("previous");
	painted = true;
	runNextFrame();
	expect(anchor).toBe("new");
	expect(frameRef.current).toBeNull();
});

test("hides only after the poll gives up", () => {
	const frameRef = { current: null as number | null };
	let anchor = "previous";
	pollUntilReady(
		() => false,
		frameRef,
		2,
		() => {
			anchor = "hidden";
		},
	);
	expect(anchor).toBe("previous");
	runNextFrame();
	expect(anchor).toBe("previous");
	runNextFrame();
	expect(anchor).toBe("hidden");
});

test("a newer poll cancels the older poll's exhaustion callback", () => {
	const frameRef = { current: null as number | null };
	let anchor = "previous";
	pollUntilReady(
		() => false,
		frameRef,
		1,
		() => {
			anchor = "hidden";
		},
	);
	pollUntilReady(() => {
		anchor = "new";
		return true;
	}, frameRef);
	expect(anchor).toBe("new");
	expect(frames.size).toBe(0);
});
