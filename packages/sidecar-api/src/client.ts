import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { RouterContractClient } from "@orpc/contract";
import type { contract } from "./contract.ts";

/** Typed contract client — every procedure in `contract`, fully typed end to end. */
export type SidecarClient = RouterContractClient<typeof contract>;

/**
 * Build a typed oRPC client against a running sidecar's `{ port, token }`.
 *
 * `host` defaults to loopback, which is right for every caller that runs on the
 * same machine as the sidecar — the CLI, the lock's liveness check, the Tauri
 * webview. The exception is the browser dev harness reached from *another*
 * device over the LAN (`bun dev --browser --host`): there the page is the only
 * thing that knows which address the sidecar was reached at, so it passes its
 * own `window.location.hostname` rather than letting this default to a loopback
 * that would resolve to the phone/tablet itself. See
 * `apps/desktop/src/lib/backend.ts`.
 */
export function makeSidecarClient(options: {
	readonly port: number;
	readonly token: string;
	readonly host?: string;
}): SidecarClient {
	const link = new RPCLink({
		origin: `http://${options.host ?? "127.0.0.1"}:${options.port}`,
		url: "/api",
		fetch: (url, init) => {
			// `init.headers` can be a `Headers` instance, a plain object, or a tuple
			// array — spreading a `Headers` instance directly (`{...init.headers}`)
			// silently yields `{}` (its entries aren't enumerable own properties),
			// dropping every header RPCLink set, including `Content-Type`. Route
			// through the `Headers` constructor so all three shapes merge correctly.
			const headers = new Headers(init?.headers);
			headers.set("authorization", `Bearer ${options.token}`);
			return globalThis.fetch(url, { ...init, headers });
		},
	});

	return createORPCClient(link);
}
