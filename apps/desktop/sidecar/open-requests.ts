import type {
	OpenRequest,
	OpenSessionTarget,
	Session,
} from "@repo/sidecar-api";
import { emit, subscribe } from "./events.ts";

const requests = new Map<string, OpenRequest>();
const pendingActivations = new Set<string>();

export function createOpenRequest(
	cwd: string,
	target: OpenSessionTarget,
): OpenRequest {
	const request: OpenRequest = {
		id: crypto.randomUUID(),
		cwd,
		target,
		status: { kind: "pending" },
	};
	requests.set(request.id, request);
	pendingActivations.add(request.id);
	emit({ type: "open-requested", request });
	return request;
}

export function resolveOpenRequest(id: string, session: Session): void {
	const request = requests.get(id);
	if (request === undefined) throw new Error(`unknown open request: ${id}`);
	const resolved: OpenRequest = {
		...request,
		status: { kind: "opened", session },
	};
	requests.set(id, resolved);
	emit({ type: "open-resolved", request: resolved });
}

export function failOpenRequest(id: string, message: string): void {
	const request = requests.get(id);
	if (request === undefined) throw new Error(`unknown open request: ${id}`);
	const failed: OpenRequest = {
		...request,
		status: { kind: "failed", message },
	};
	requests.set(id, failed);
	emit({ type: "open-failed", request: failed });
}

export function listOpenRequests(): readonly OpenRequest[] {
	return [...requests.values()];
}

export function acknowledgeOpenRequest(id: string): void {
	requests.delete(id);
}

export function acknowledgeActivation(id: string): void {
	pendingActivations.delete(id);
}

export function subscribeToActivations(send: (id: string) => void): () => void {
	const unsubscribe = subscribe((event) => {
		if (event.type === "open-requested") send(event.request.id);
	});
	for (const id of pendingActivations) send(id);
	return unsubscribe;
}
