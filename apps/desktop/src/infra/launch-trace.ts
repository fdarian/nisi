import type { OpenRequest, SidecarClient } from "@repo/sidecar-api";
import { useEffect, useSyncExternalStore } from "react";

type Mark = { at: number; name: string; tab?: string };
type Trace = {
	id: string;
	client: SidecarClient;
	sessionId?: string;
	seen: Set<string>;
	queue: Mark[];
	sending: Promise<void>;
	finished: boolean;
};
const boot: Mark[] = [
	{ at: performance.timeOrigin, name: "frontend.navigation-start" },
];
const state: { trace?: Trace } = {};
const listeners = new Set<() => void>();
const now = () => performance.timeOrigin + performance.now();
export function frontendBootMark(name: string): void {
	if (!boot.some((mark) => mark.name === name)) boot.push({ at: now(), name });
}

export function receiveTracedOpen(
	request: OpenRequest,
	client: SidecarClient,
): void {
	if (request.traceId === undefined) return;
	if (state.trace?.id !== request.traceId) {
		state.trace = {
			id: request.traceId,
			client,
			seen: new Set(),
			queue: [...boot],
			sending: Promise.resolve(),
			finished: false,
		};
		launchMark("open-requested.received");
	}
	if (request.status.kind === "opened") {
		state.trace.sessionId = request.status.session.id;
		launchMark("open-resolved.received");
	}
	for (const listener of listeners) listener();
}

function flush(trace: Trace): void {
	if (trace.seen.has("tab.content.painted") && !trace.finished) {
		trace.queue.push({ at: now(), name: "trace.done" });
		trace.finished = true;
	}
	const marks = trace.queue.splice(0);
	if (marks.length === 0) return;
	trace.sending = trace.sending.then(() =>
		trace.client.diagnostics.launchMarks({ traceId: trace.id, marks }),
	);
	void trace.sending.catch((error) =>
		console.error("Launch trace delivery failed", error),
	);
}

export function launchMark(
	name: string,
	tab?: string,
	sessionId?: string,
): void {
	const trace = state.trace;
	if (trace === undefined || trace.finished || trace.seen.has(name)) return;
	if (sessionId !== undefined && trace.sessionId !== sessionId) return;
	trace.seen.add(name);
	trace.queue.push({ at: now(), name });
	if (tab !== undefined && !trace.seen.has("tab.content.painted")) {
		trace.queue.push({ at: now(), name: "tab.content.painted", tab });
		trace.seen.add("tab.content.painted");
	}
	setTimeout(() => flush(trace), 0);
}

const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
};
const snapshot = () =>
	state.trace === undefined
		? undefined
		: `${state.trace.id}:${state.trace.sessionId}`;

export function useLaunchMark(
	name: string,
	enabled = true,
	tab?: string,
	sessionId?: string,
): void {
	const trace = useLaunchTrace();
	useEffect(() => {
		if (trace === undefined || !enabled) return;
		const frame = requestAnimationFrame(() => launchMark(name, tab, sessionId));
		return () => cancelAnimationFrame(frame);
	}, [trace, name, enabled, tab, sessionId]);
}

export function markDiffPainted(sessionId: string, node: HTMLElement): void {
	const trace = state.trace;
	if (trace === undefined || trace.finished || trace.sessionId !== sessionId)
		return;
	requestAnimationFrame(() => {
		if (node.isConnected && node.getBoundingClientRect().height > 0)
			launchMark("files.first-diff.painted", "files", sessionId);
	});
}

export const useLaunchTrace = () => useSyncExternalStore(subscribe, snapshot);
