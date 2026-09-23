import {
	acknowledgeActivation,
	subscribeToActivations,
} from "./open-requests.ts";

const OWNER_RECONNECT_GRACE_MS = 2_000;
const OWNER_INITIAL_CONNECT_GRACE_MS = 10_000;

export function createNativeActivationHandler(
	token: string,
	initialOwnerId?: string,
) {
	let ownerId = initialOwnerId;
	let activeStreams = 0;
	let reservedUntil = Date.now() + OWNER_INITIAL_CONNECT_GRACE_MS;

	return (request: Request): Response | undefined => {
		const url = new URL(request.url);
		if (!url.pathname.startsWith("/native/activation")) return undefined;
		if (request.headers.get("authorization") !== `Bearer ${token}`) {
			return new Response("unauthorized", { status: 401 });
		}
		const candidate = request.headers.get("x-nisi-activation-owner");
		if (candidate === null || candidate.length === 0) {
			return new Response("missing activation owner", { status: 400 });
		}
		if (
			url.pathname === "/native/activation/claim" &&
			request.method === "POST"
		) {
			if (candidate !== ownerId) {
				if (
					ownerId !== undefined &&
					(activeStreams > 0 || Date.now() < reservedUntil)
				) {
					return new Response("activation owner is connected or reconnecting", {
						status: 409,
					});
				}
				ownerId = candidate;
			}
			reservedUntil = Date.now() + OWNER_RECONNECT_GRACE_MS;
			return new Response(null, { status: 204 });
		}
		if (ownerId === undefined || candidate !== ownerId) {
			return new Response("not the owning app", { status: 403 });
		}
		if (
			url.pathname === "/native/activation/ack" &&
			request.method === "POST"
		) {
			const id = url.searchParams.get("id");
			if (id === null) return new Response("missing id", { status: 400 });
			acknowledgeActivation(id);
			return new Response(null, { status: 204 });
		}
		if (url.pathname !== "/native/activation" || request.method !== "GET") {
			return new Response("not found", { status: 404 });
		}

		let unsubscribe: (() => void) | undefined;
		let heartbeat: ReturnType<typeof setInterval> | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				activeStreams++;
				const encoder = new TextEncoder();
				unsubscribe = subscribeToActivations((id) => {
					controller.enqueue(encoder.encode(`${JSON.stringify({ id })}\n`));
				});
				heartbeat = setInterval(
					() => controller.enqueue(encoder.encode("\n")),
					5_000,
				);
			},
			cancel() {
				if (heartbeat !== undefined) clearInterval(heartbeat);
				unsubscribe?.();
				activeStreams--;
				reservedUntil = Date.now() + OWNER_RECONNECT_GRACE_MS;
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "application/x-ndjson",
				"cache-control": "no-store",
			},
		});
	};
}
