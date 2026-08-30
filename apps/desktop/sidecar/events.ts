import type { Session } from "./store.ts";

export type SidecarEvent =
	| { readonly type: "session-opened"; readonly session: Session }
	| { readonly type: "session-closed"; readonly sessionId: string }
	| { readonly type: "session-files-changed"; readonly sessionId: string }
	| { readonly type: "session-updated"; readonly session: Session };

type Subscriber = (event: SidecarEvent) => void;

const subscribers = new Set<Subscriber>();

export function subscribe(fn: Subscriber): () => void {
	subscribers.add(fn);
	return () => {
		subscribers.delete(fn);
	};
}

export function emit(event: SidecarEvent): void {
	for (const fn of subscribers) {
		fn(event);
	}
}
