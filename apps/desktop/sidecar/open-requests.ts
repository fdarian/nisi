import type {
	OpenRequest,
	OpenSessionTarget,
	Session,
} from "@repo/sidecar-api";
import { emit, subscribe } from "./events.ts";

const MAX_RETAINED = 100;
const RETENTION_MS = 30 * 60_000;
const requests = new Map<
	string,
	{ request: OpenRequest; settledAt?: number }
>();
const pendingActivations = new Map<string, number>();

function prune(): void {
	const now = Date.now();
	for (const [id, entry] of requests) {
		if (
			entry.settledAt !== undefined &&
			now - entry.settledAt >= RETENTION_MS
		) {
			requests.delete(id);
		}
	}
	for (const [id, createdAt] of pendingActivations) {
		if (now - createdAt >= RETENTION_MS) pendingActivations.delete(id);
	}
	for (const [id, entry] of requests) {
		if (requests.size <= MAX_RETAINED) break;
		if (entry.settledAt !== undefined) requests.delete(id);
	}
	for (const id of pendingActivations.keys()) {
		if (pendingActivations.size <= MAX_RETAINED) break;
		pendingActivations.delete(id);
	}
}

export function createOpenRequest(
	cwd: string,
	target: OpenSessionTarget,
): OpenRequest {
	prune();
	const request: OpenRequest = {
		id: crypto.randomUUID(),
		cwd,
		target,
		status: { kind: "pending" },
	};
	requests.set(request.id, { request });
	pendingActivations.set(request.id, Date.now());
	prune();
	emit({ type: "open-requested", request });
	return request;
}

export function resolveOpenRequest(id: string, session: Session): void {
	const entry = requests.get(id);
	if (entry === undefined) throw new Error(`unknown open request: ${id}`);
	const resolved: OpenRequest = {
		...entry.request,
		status: { kind: "opened", session },
	};
	requests.set(id, { request: resolved, settledAt: Date.now() });
	prune();
	emit({ type: "open-resolved", request: resolved });
}

export function failOpenRequest(id: string, message: string): void {
	const entry = requests.get(id);
	if (entry === undefined) throw new Error(`unknown open request: ${id}`);
	const failed: OpenRequest = {
		...entry.request,
		status: { kind: "failed", message },
	};
	requests.set(id, { request: failed, settledAt: Date.now() });
	prune();
	emit({ type: "open-failed", request: failed });
}

export function listOpenRequests(): readonly OpenRequest[] {
	prune();
	return [...requests.values()].map((entry) => entry.request);
}

export function acknowledgeOpenRequest(id: string): void {
	requests.delete(id);
}

export function acknowledgeActivation(id: string): void {
	pendingActivations.delete(id);
}

export function subscribeToActivations(send: (id: string) => void): () => void {
	prune();
	const unsubscribe = subscribe((event) => {
		if (event.type === "open-requested") send(event.request.id);
	});
	for (const id of pendingActivations.keys()) send(id);
	return unsubscribe;
}
