import type { LaunchMark, OpenRequest, SidecarClient } from "@repo/sidecar-api";
import { useEffect, useSyncExternalStore } from "react";

type Mark = LaunchMark;
type LaunchMarkOptions = {
	when?: boolean;
	sessionId?: string;
	tab?: string;
	hidden?: boolean;
};
type Trace = {
	id: string;
	client: { diagnostics: Pick<SidecarClient["diagnostics"], "launchMarks"> };
	sessionId?: string;
	seen: Set<string>;
	queue: Mark[];
	sending: Promise<void>;
	finished: boolean;
};
const boot: Mark[] = [
	{
		type: "mark",
		source: "frontend",
		at: performance.timeOrigin,
		name: "frontend.navigation-start",
		attrs: {},
	},
];
const state: { trace?: Trace } = {};
const listeners = new Set<() => void>();
function recordVisibility(): void {
	launchMark("frontend.visibility", { hidden: document.hidden });
}
export function frontendBootMark(name: string): void {
	if (!boot.some((mark) => mark.name === name))
		boot.push({
			type: "mark",
			source: "frontend",
			at: Date.now(),
			name,
			attrs: {},
		});
}

export function receiveTracedOpen(
	request: OpenRequest,
	client: { diagnostics: Pick<SidecarClient["diagnostics"], "launchMarks"> },
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
		document.removeEventListener("visibilitychange", recordVisibility);
		document.addEventListener("visibilitychange", recordVisibility);
		recordVisibility();
	}
	if (request.status.kind === "opened") {
		state.trace.sessionId = request.status.session.id;
		launchMark("open-resolved.received");
	}
	for (const listener of listeners) listener();
}

function flush(trace: Trace): void {
	if (trace.seen.has("tab.content.painted") && !trace.finished) {
		trace.queue.push({
			type: "mark",
			source: "frontend",
			at: Date.now(),
			name: "trace.done",
			attrs: {},
		});
		trace.finished = true;
		if (state.trace === trace)
			document.removeEventListener("visibilitychange", recordVisibility);
	}
	const marks = trace.queue.splice(0);
	if (marks.length === 0) return;
	trace.sending = trace.sending
		.then(() =>
			trace.client.diagnostics.launchMarks({ traceId: trace.id, marks }),
		)
		.catch((error) => console.warn("Launch trace delivery failed", error));
}

export function launchMark(
	name: string,
	options: LaunchMarkOptions = {},
): void {
	const trace = state.trace;
	if (
		trace === undefined ||
		trace.finished ||
		(name !== "frontend.visibility" && trace.seen.has(name))
	)
		return;
	if (options.sessionId !== undefined && trace.sessionId !== options.sessionId)
		return;
	trace.seen.add(name);
	trace.queue.push({
		type: "mark",
		source: "frontend",
		at: Date.now(),
		name,
		attrs: options.hidden === undefined ? {} : { hidden: options.hidden },
	});
	if (options.tab !== undefined && !trace.seen.has("tab.content.painted")) {
		trace.queue.push({
			type: "mark",
			source: "frontend",
			at: Date.now(),
			name: "tab.content.painted",
			attrs: { tab: options.tab },
		});
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
	options: LaunchMarkOptions = {},
): void {
	const trace = useLaunchTrace();
	useEffect(() => {
		if (trace === undefined || options.when === false) return;
		const frame = requestAnimationFrame(() =>
			launchMark(name, { tab: options.tab, sessionId: options.sessionId }),
		);
		return () => cancelAnimationFrame(frame);
	}, [trace, name, options.when, options.tab, options.sessionId]);
}

export function markDiffPainted(sessionId: string, node: HTMLElement): void {
	const trace = state.trace;
	if (trace === undefined || trace.finished || trace.sessionId !== sessionId)
		return;
	requestAnimationFrame(() => {
		if (node.isConnected && node.getBoundingClientRect().height > 0)
			launchMark("files.first-diff.painted", { tab: "files", sessionId });
	});
}

export function markFilesLoadingPainted(
	node: HTMLElement,
	sessionId?: string,
): void {
	const trace = state.trace;
	if (
		trace === undefined ||
		trace.finished ||
		(sessionId !== undefined && trace.sessionId !== sessionId)
	)
		return;
	requestAnimationFrame(() => {
		if (
			state.trace === trace &&
			node.isConnected &&
			node.getBoundingClientRect().height > 0
		)
			launchMark("files.loading.painted", { sessionId });
	});
}

export const useLaunchTrace = () => useSyncExternalStore(subscribe, snapshot);

export function receiveTracedDeepLink(
	traceId: string,
	client: Trace["client"],
): void {
	if (state.trace?.id === traceId) return;
	state.trace = {
		id: traceId,
		client,
		seen: new Set(),
		queue: [...boot],
		sending: Promise.resolve(),
		finished: false,
	};
	launchMark("deeplink.received");
	document.removeEventListener("visibilitychange", recordVisibility);
	document.addEventListener("visibilitychange", recordVisibility);
	recordVisibility();
	for (const listener of listeners) listener();
}

export function resolveTracedDeepLink(
	traceId: string,
	sessionId: string,
): void {
	if (state.trace?.id !== traceId) return;
	state.trace.sessionId = sessionId;
	launchMark("pull-requests.open.resolved", { sessionId });
	for (const listener of listeners) listener();
}
