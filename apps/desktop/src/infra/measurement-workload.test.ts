import { expect, test } from "bun:test";
import {
	createWorkloadRunner,
	type ScrollablePane,
	scrollThrough,
} from "./measurement-workload";

const instantClock = {
	sleep: async () => {},
	nextFrame: async () => {},
};

function fakePane(options: { height: number; scrollHeights: number[] }) {
	const positions: number[] = [];
	let reads = 0;
	const pane: ScrollablePane = {
		getViewport: () => {
			const scrollHeight =
				options.scrollHeights[
					Math.min(reads, options.scrollHeights.length - 1)
				] ?? 0;
			reads += 1;
			return {
				scrollTop: positions.at(-1) ?? 0,
				height: options.height,
				scrollHeight,
			};
		},
		scrollToPosition: (position) => {
			positions.push(position);
		},
	};
	return { pane, positions };
}

test("scrolls one viewport at a time to the bottom, then back to the top", async () => {
	const { pane, positions } = fakePane({ height: 100, scrollHeights: [350] });
	const result = await scrollThrough(pane, instantClock, 0);
	expect(positions).toEqual([0, 100, 200, 250, 0]);
	expect(result.steps).toBe(3);
});

test("follows a total height that grows as files render", async () => {
	const { pane, positions } = fakePane({
		height: 100,
		scrollHeights: [200, 400],
	});
	await scrollThrough(pane, instantClock, 0);
	expect(positions.at(-2)).toBe(300);
	expect(positions.at(-1)).toBe(0);
});

test("a pane shorter than its viewport only returns to the top", async () => {
	const { pane, positions } = fakePane({ height: 100, scrollHeights: [80] });
	const result = await scrollThrough(pane, instantClock, 0);
	expect(positions).toEqual([0, 0]);
	expect(result.steps).toBe(0);
});

test("a replayed step is performed once and re-acknowledged after it finished", async () => {
	const performed: string[] = [];
	const acks: unknown[] = [];
	const run = createWorkloadRunner({
		perform: async (step) => {
			performed.push(step);
		},
		ack: async (id, outcome) => {
			acks.push([id, outcome]);
		},
	});
	run({ id: "a", step: "scroll-files-changed" });
	run({ id: "a", step: "scroll-files-changed" });
	await Promise.resolve();
	await Promise.resolve();
	run({ id: "a", step: "scroll-files-changed" });
	await Promise.resolve();
	expect(performed).toEqual(["scroll-files-changed"]);
	expect(acks).toEqual([
		["a", { ok: true }],
		["a", { ok: true }],
	]);
});

test("a failing step is acknowledged with its error message", async () => {
	const acks: unknown[] = [];
	const run = createWorkloadRunner({
		perform: async () => {
			throw new Error("no pane");
		},
		ack: async (id, outcome) => {
			acks.push([id, outcome]);
		},
	});
	run({ id: "b", step: "close-other-tabs" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(acks).toEqual([["b", { ok: false, error: "no pane" }]]);
});
