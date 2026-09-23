import type { SidecarClient, SidecarEvent } from "@repo/sidecar-api";
import { createContext, useContext, useEffect, useRef } from "react";

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
