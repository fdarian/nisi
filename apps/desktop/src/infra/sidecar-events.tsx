import type { SidecarClient, SidecarEvent } from "@repo/sidecar-api";
import { createContext, useContext, useEffect, useRef } from "react";
import { frontendBootMark, receiveTracedDeepLink } from "./launch-trace";
import { enqueueInjectedDeepLink } from "#/shell/deep-link/deep-link-store";

type Listener = (event: SidecarEvent) => void;
const EventContext = createContext<((listener: Listener) => () => void) | null>(
	null,
);

export function SidecarEventsProvider(props: {
	client: SidecarClient;
	children: React.ReactNode;
}): React.ReactElement {
	const listeners = useRef(new Set<Listener>());
	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			while (!controller.signal.aborted) {
				try {
					for await (const event of await props.client.events.subscribe(
						undefined,
						{
							signal: controller.signal,
						},
					)) {
						if (event.type === "stream-ready")
							frontendBootMark("frontend.events.connected");
						if (event.type === "deep-link-injected") {
							receiveTracedDeepLink(event.traceId, props.client);
							enqueueInjectedDeepLink(event.url, event.traceId);
							void props.client.diagnostics
								.ackDeepLink({ traceId: event.traceId })
								.catch((error) =>
									console.warn("Deep-link acknowledgment failed", error),
								);
						}
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
	const subscribe = useRef((listener: Listener) => {
		listeners.current.add(listener);
		return () => {
			listeners.current.delete(listener);
		};
	});
	return (
		<EventContext.Provider value={subscribe.current}>
			{props.children}
		</EventContext.Provider>
	);
}

export function useSidecarEvent(listener: Listener): void {
	const subscribe = useContext(EventContext);
	if (subscribe === null) throw new Error("SidecarEventsProvider missing");
	const callback = useRef(listener);
	callback.current = listener;
	useEffect(() => subscribe((event) => callback.current(event)), [subscribe]);
}
