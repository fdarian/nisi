import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { makeSidecarClient, type SidecarClient } from "@repo/sidecar-api";
import type React from "react";
import { createContext, useContext, useEffect, useState } from "react";
import type { BackendInfo } from "./backend";
import { getBackend } from "./backend";

/** TanStack Query utils for the sidecar's oRPC contract — built once `{ port, token }` resolves. */
type SidecarQueryUtils = ReturnType<
	typeof createTanstackQueryUtils<SidecarClient>
>;

type BackendContextValue =
	| { status: "loading" }
	| { status: "error"; message: string }
	| { status: "ready"; backend: BackendInfo; orpc: SidecarQueryUtils };

const BackendContext = createContext<BackendContextValue>({
	status: "loading",
});

function BackendProvider({ children }: { children: React.ReactNode }) {
	const [value, setValue] = useState<BackendContextValue>({
		status: "loading",
	});

	useEffect(() => {
		getBackend()
			.then((backend) => {
				const client = makeSidecarClient(backend);
				const orpc = createTanstackQueryUtils(client);
				setValue({ status: "ready", backend, orpc });
			})
			.catch((err) => {
				setValue({
					status: "error",
					message: err instanceof Error ? err.message : String(err),
				});
			});
	}, []);

	return (
		<BackendContext.Provider value={value}>{children}</BackendContext.Provider>
	);
}

function useBackendContext(): BackendContextValue {
	return useContext(BackendContext);
}

export type { SidecarQueryUtils };
export { BackendProvider, useBackendContext };
