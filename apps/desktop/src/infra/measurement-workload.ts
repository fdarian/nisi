import type { SidecarClient, WorkloadStep } from "@repo/sidecar-api";
import { useEffect } from "react";

/**
 * The scripted interactions behind `measure-launch --soak`. The sidecar's
 * `measurement-workload` event (gated by `NISI_MEASUREMENT_INSTANCE`) lands here,
 * so the same steps run in any shell: no CDP, nothing engine-specific.
 */

export type ScrollViewport = {
	scrollTop: number;
	height: number;
	scrollHeight: number;
};

/** The slice of the diff pane's imperative handle the scroll step needs. */
export type ScrollablePane = {
	getViewport: () => ScrollViewport | undefined;
	scrollToPosition: (position: number) => void;
};

export type TabsShell = {
	activeSessionId: string | null;
	sessionIds: readonly string[];
	closeOtherTabs: (keepSessionId: string) => void;
};

type Clock = {
	sleep: (ms: number) => Promise<void>;
	nextFrame: () => Promise<void>;
};

const SCROLL_STEP_INTERVAL_MS = 250;
const READY_TIMEOUT_MS = 30_000;
const MAX_SCROLL_STEPS = 5000;
const CLOSE_TIMEOUT_MS = 15_000;

const diffPanes = new Map<string, ScrollablePane>();
const tabs: { current: TabsShell | undefined } = { current: undefined };

const realClock: Clock = {
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	// A hidden document never fires animation frames; the timeout keeps the step moving.
	nextFrame: () =>
		new Promise((resolve) => {
			const timeout = setTimeout(resolve, 100);
			requestAnimationFrame(() => {
				clearTimeout(timeout);
				resolve();
			});
		}),
};

export function registerDiffPane(
	sessionId: string,
	pane: ScrollablePane,
): () => void {
	diffPanes.set(sessionId, pane);
	return () => {
		if (diffPanes.get(sessionId) === pane) diffPanes.delete(sessionId);
	};
}

export function useRegisterDiffPane(
	sessionId: string,
	getPane: () => ScrollablePane | null,
): void {
	useEffect(
		() =>
			registerDiffPane(sessionId, {
				getViewport: () => getPane()?.getViewport(),
				scrollToPosition: (position) => getPane()?.scrollToPosition(position),
			}),
		[sessionId, getPane],
	);
}

export function useMeasurementTabs(shell: TabsShell): void {
	useEffect(() => {
		tabs.current = shell;
	});
	useEffect(
		() => () => {
			tabs.current = undefined;
		},
		[],
	);
}

async function waitUntil<T>(
	read: () => T | undefined,
	what: string,
	timeoutMs: number,
	clock: Clock,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (value !== undefined) return value;
		if (Date.now() >= deadline)
			throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
		await clock.sleep(100);
	}
}

/**
 * Scrolls top to bottom one viewport at a time, then back to the top. The total
 * height is re-read every step because the virtualizer replaces its estimate for
 * each file with the measured height as the file renders.
 */
export async function scrollThrough(
	pane: ScrollablePane,
	clock: Clock,
	intervalMs: number = SCROLL_STEP_INTERVAL_MS,
): Promise<{ steps: number }> {
	const ready = await waitUntil(
		() => {
			const viewport = pane.getViewport();
			return viewport !== undefined && viewport.scrollHeight > 0
				? viewport
				: undefined;
		},
		"the diff pane to have content",
		READY_TIMEOUT_MS,
		clock,
	);
	pane.scrollToPosition(0);
	await clock.nextFrame();
	let top = 0;
	let steps = 0;
	let viewport: ScrollViewport = ready;
	while (true) {
		const maxTop = Math.max(0, viewport.scrollHeight - viewport.height);
		if (top >= maxTop) break;
		if (steps >= MAX_SCROLL_STEPS)
			throw new Error(`Still scrolling after ${MAX_SCROLL_STEPS} steps`);
		top = Math.min(top + viewport.height, maxTop);
		pane.scrollToPosition(top);
		steps += 1;
		await clock.nextFrame();
		await clock.sleep(intervalMs);
		const next = pane.getViewport();
		if (next === undefined)
			throw new Error("The diff pane went away mid-scroll");
		viewport = next;
	}
	pane.scrollToPosition(0);
	await clock.nextFrame();
	await clock.sleep(intervalMs);
	return { steps };
}

async function scrollFilesChanged(clock: Clock): Promise<void> {
	const shell = tabs.current;
	if (shell === undefined) throw new Error("The tab shell is not mounted");
	const sessionId = shell.activeSessionId;
	if (sessionId === null) throw new Error("No active PR tab");
	const pane = await waitUntil(
		() => diffPanes.get(sessionId),
		`the Files Changed diff pane of ${sessionId}`,
		READY_TIMEOUT_MS,
		clock,
	);
	await scrollThrough(pane, clock);
}

async function closeOtherTabs(clock: Clock): Promise<void> {
	const shell = tabs.current;
	if (shell === undefined) throw new Error("The tab shell is not mounted");
	const first = shell.sessionIds[0];
	if (first === undefined) throw new Error("No PR tab is open");
	shell.closeOtherTabs(first);
	await waitUntil(
		() => (tabs.current?.sessionIds.length === 1 ? true : undefined),
		"the other tabs to close",
		CLOSE_TIMEOUT_MS,
		clock,
	);
}

const steps: Record<WorkloadStep, (clock: Clock) => Promise<void>> = {
	"scroll-files-changed": scrollFilesChanged,
	"close-other-tabs": closeOtherTabs,
};

type Outcome = { ok: boolean; error?: string };

/**
 * A step replays on every event-stream reconnect until the sidecar has its ack, so
 * an id is performed once; a replay of a finished one only repeats the ack.
 */
export function createWorkloadRunner(deps: {
	perform: (step: WorkloadStep) => Promise<void>;
	ack: (id: string, outcome: Outcome) => Promise<void>;
}): (event: { id: string; step: WorkloadStep }) => void {
	const started = new Set<string>();
	const outcomes = new Map<string, Outcome>();
	const report = (id: string, outcome: Outcome) =>
		deps
			.ack(id, outcome)
			.catch((error) =>
				console.warn("Workload step acknowledgment failed", error),
			);
	return (event) => {
		const finished = outcomes.get(event.id);
		if (finished !== undefined) {
			void report(event.id, finished);
			return;
		}
		if (started.has(event.id)) return;
		started.add(event.id);
		void deps.perform(event.step).then(
			() => {
				outcomes.set(event.id, { ok: true });
				return report(event.id, { ok: true });
			},
			(error) => {
				const outcome = {
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
				outcomes.set(event.id, outcome);
				return report(event.id, outcome);
			},
		);
	};
}

export function runWorkloadStepFor(client: {
	diagnostics: Pick<SidecarClient["diagnostics"], "ackWorkloadStep">;
}): (event: { id: string; step: WorkloadStep }) => void {
	return createWorkloadRunner({
		perform: (step) => steps[step](realClock),
		ack: (id, outcome) =>
			client.diagnostics.ackWorkloadStep({
				id,
				ok: outcome.ok,
				error: outcome.error,
			}),
	});
}
