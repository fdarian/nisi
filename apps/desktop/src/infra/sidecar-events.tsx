import type { SidecarClient, SidecarEvent } from "@repo/sidecar-api";
import { createContext, useContext, useEffect, useRef } from "react";
import { enqueueInjectedDeepLink } from "#/shell/deep-link/deep-link-store";
import { frontendBootMark, receiveTracedDeepLink } from "./launch-trace";
import { runWorkloadStepFor } from "./measurement-workload";

type Listener = (event: SidecarEvent) => void;
type ReconnectListener = () => void;
type Subscriptions = {
	events: (listener: Listener) => () => void;
	reconnects: (listener: ReconnectListener) => () => void;
};
const EventContext = createContext<Subscriptions | null>(null);

function subscribeTo<T>(set: Set<T>) {
	return (listener: T) => {
		set.add(listener);
		return () => {
			set.delete(listener);
		};
	};
}

export function SidecarEventsProvider(props: {
	client: SidecarClient;
	children: React.ReactNode;
}): React.ReactElement {
	const listeners = useRef(new Set<Listener>());
	const reconnectListeners = useRef(new Set<ReconnectListener>());
	useEffect(() => {
		const controller = new AbortController();
		let hasConnected = false;
		const performWorkloadStep = runWorkloadStepFor(props.client);
		void (async () => {
			while (!controller.signal.aborted) {
				try {
					for await (const event of await props.client.events.subscribe(
						undefined,
						{
							signal: controller.signal,
						},
					)) {
						if (event.type === "stream-ready") {
							frontendBootMark("frontend.events.connected");
							if (hasConnected)
								for (const listener of reconnectListeners.current) listener();
							hasConnected = true;
						}
						if (event.type === "deep-link-injected") {
							receiveTracedDeepLink(event.traceId, props.client);
							enqueueInjectedDeepLink(event.url, event.traceId);
							void props.client.diagnostics
								.ackDeepLink({ traceId: event.traceId })
								.catch((error) =>
									console.warn("Deep-link acknowledgment failed", error),
								);
						}
						if (event.type === "measurement-workload")
							performWorkloadStep(event);
						for (const listener of listeners.current) listener(event);
					}
				} catch (error) {
					if (!controller.signal.aborted)
						console.error("Sidecar event stream disconnected", error);
				}
				if (!controller.signal.aborted)
					await new Promise((resolve) => setTimeout(resolve, 500));
			}
		})();
		return () => controller.abort();
	}, [props.client]);
	const subscriptions = useRef<Subscriptions>({
		events: subscribeTo(listeners.current),
		reconnects: subscribeTo(reconnectListeners.current),
	});
	return (
		<EventContext.Provider value={subscriptions.current}>
			{props.children}
		</EventContext.Provider>
	);
}

function useSubscriptions(): Subscriptions {
	const subscriptions = useContext(EventContext);
	if (subscriptions === null) throw new Error("SidecarEventsProvider missing");
	return subscriptions;
}

export function useSidecarEvent(listener: Listener): void {
	const subscribe = useSubscriptions().events;
	const callback = useRef(listener);
	callback.current = listener;
	useEffect(() => subscribe((event) => callback.current(event)), [subscribe]);
}

/**
 * Fires when the event stream comes back after an earlier connection — i.e.
 * the sidecar restarted (a dev reload) and lost its in-memory state: watch
 * registrations, head pins. Not called for the first connection.
 */
export function useSidecarReconnect(listener: ReconnectListener): void {
	const subscribe = useSubscriptions().reconnects;
	const callback = useRef(listener);
	callback.current = listener;
	useEffect(() => subscribe(() => callback.current()), [subscribe]);
}
