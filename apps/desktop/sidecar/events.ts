import type { CodeIndexLspStatus, OpenRequest } from "@repo/sidecar-api";
import type { Session } from "./store.ts";

type EventPayload =
	| { readonly type: "session-opened"; readonly session: Session }
	| { readonly type: "session-closed"; readonly sessionId: string }
	| { readonly type: "session-files-changed"; readonly sessionId: string }
	| { readonly type: "session-updated"; readonly session: Session }
	| {
			readonly type: "code-index-lsp-status-changed";
			readonly repoRoot: string;
			readonly status: CodeIndexLspStatus;
	  }
	| { readonly type: "open-requested"; readonly request: OpenRequest }
	| { readonly type: "open-resolved"; readonly request: OpenRequest }
	| { readonly type: "open-failed"; readonly request: OpenRequest };

export type SidecarEvent = EventPayload & { readonly seq: number };
export type StreamReadyEvent = {
	readonly type: "stream-ready";
	readonly seq: number;
};

type Subscriber = (event: SidecarEvent) => void;

const subscribers = new Set<Subscriber>();
let nextSeq = 1;

export function streamReady(): StreamReadyEvent {
	return { type: "stream-ready", seq: nextSeq++ };
}

export function subscribe(fn: Subscriber): () => void {
	subscribers.add(fn);
	return () => {
		subscribers.delete(fn);
	};
}

export function emit(payload: EventPayload): SidecarEvent {
	const event = { ...payload, seq: nextSeq++ };
	for (const fn of subscribers) {
		fn(event);
	}
	return event;
}
