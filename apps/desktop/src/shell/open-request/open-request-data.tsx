import type { OpenRequest } from "@repo/sidecar-api";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
	createContext,
	useCallback,
	useContext,
	useRef,
	useState,
} from "react";
import { useBackendContext } from "#/infra/backend-context";
import { receiveTracedOpen } from "#/infra/launch-trace";
import { useSidecarEvent } from "#/infra/sidecar-events";
import { prefetchResolvedFiles } from "./resolved-files";
import { seedResolvedSession } from "./resolved-session-cache";

type OpenRequestContextValue = {
	request: OpenRequest | null;
	acknowledge: (id: string) => void;
};
const OpenRequestContext = createContext<OpenRequestContextValue | null>(null);

export function OpenRequestProvider(props: {
	children: React.ReactNode;
}): React.ReactElement {
	const backend = useBackendContext();
	if (backend.status !== "ready")
		throw new Error("OpenRequestProvider requires a backend");
	const client = backend.client;
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [requests, setRequests] = useState<readonly OpenRequest[]>([]);
	const acknowledging = useRef(new Set<string>());

	const merge = useCallback(
		(request: OpenRequest) => {
			receiveTracedOpen(request, client);
			if (request.status.kind === "opened") {
				void prefetchResolvedFiles(
					queryClient,
					backend.orpc,
					request.status.session.id,
				).catch((error) =>
					console.error("Failed to prefetch resolved files", error),
				);
				seedResolvedSession(
					queryClient,
					backend.orpc.sessions.list.queryKey(),
					request.status.session,
				);
			}
			setRequests((current) => {
				if (acknowledging.current.has(request.id)) return current;
				const previous = current.find((entry) => entry.id === request.id);
				if (
					previous !== undefined &&
					previous.status.kind !== "pending" &&
					request.status.kind === "pending"
				)
					return current;
				return previous === undefined
					? [...current, request]
					: current.map((entry) => (entry.id === request.id ? request : entry));
			});
		},
		[client, queryClient, backend.orpc],
	);

	useSidecarEvent((event) => {
		if (event.type === "session-updated") {
			void queryClient
				.resetQueries({
					queryKey: backend.orpc.diff.files.key({
						input: { sessionId: event.session.id },
					}),
				})
				.catch((error) =>
					console.error("Failed to reset corrected file metadata", error),
				);
			void queryClient
				.resetQueries({
					queryKey: backend.orpc.diff.fileContents.key({
						input: { sessionId: event.session.id },
					}),
				})
				.catch((error) =>
					console.error("Failed to reset corrected file contents", error),
				);
			return;
		}
		if (event.type === "stream-ready") {
			void client.events
				.openRequests()
				.then((snapshot) => {
					for (const request of snapshot) merge(request);
					if (snapshot.length > 0) void navigate({ to: "/" });
				})
				.catch((error) => console.error("Failed to load pending opens", error));
			return;
		}
		if (
			event.type !== "open-requested" &&
			event.type !== "open-resolved" &&
			event.type !== "open-failed"
		)
			return;
		merge(event.request);
		if (event.type === "open-resolved") {
			void queryClient.invalidateQueries({
				queryKey: backend.orpc.sessions.list.queryKey(),
			});
		}
		void navigate({ to: "/" });
	});

	const acknowledge = useCallback(
		(id: string) => {
			if (acknowledging.current.has(id)) return;
			acknowledging.current.add(id);
			void client.events
				.ackOpenRequest({ id })
				.then(() => {
					setRequests((current) =>
						current.filter((request) => request.id !== id),
					);
				})
				.catch((error) => {
					acknowledging.current.delete(id);
					console.error("Failed to acknowledge open", error);
				});
		},
		[client],
	);

	return (
		<OpenRequestContext.Provider
			value={{ request: requests[0] ?? null, acknowledge }}
		>
			{props.children}
		</OpenRequestContext.Provider>
	);
}

export function useOpenRequest(): OpenRequestContextValue {
	const context = useContext(OpenRequestContext);
	if (context === null) throw new Error("OpenRequestProvider missing");
	return context;
}
