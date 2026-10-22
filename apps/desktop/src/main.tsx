import "./index.css";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { captureWebToken } from "#/infra/backend";
import { frontendBootMark } from "#/infra/launch-trace";
import { persistOptions } from "#/infra/query-persistence";
import { startDeepLinkListener } from "#/shell/deep-link/deep-link-store";
import { routeTree } from "./routeTree.gen";

frontendBootMark("frontend.main");

// Boot-once, before anything renders — a `nisi://` link can arrive before
// the webview exists or React mounts. See `deep-link-store.ts`'s doc
// comment for why this must never run again after this call.
void startDeepLinkListener();

// Must precede `createRouter`, which reads `location` — the token lives in the hash it strips.
captureWebToken();

const router = createRouter({ routeTree });
// The sidecar's `events.subscribe` stream (session-opened/closed,
// session-files-changed, and root-scoped LSP status) is this app's freshness
// mechanism — a blanket window-refocus refetch of every query would be
// redundant on top of that, and would defeat the Files Changed tab's
// manual-refresh gate (`useLiveFileChanges`,
// `src/features/pull-request/data/pr-data.ts`), which deliberately holds
// pending changes behind the user's click rather than auto-invalidating.
const queryClient = new QueryClient({
	defaultOptions: { queries: { refetchOnWindowFocus: false } },
});

declare module "@tanstack/react-router" {
	interface Register {
		router: typeof router;
	}
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
	<React.StrictMode>
		<PersistQueryClientProvider
			client={queryClient}
			persistOptions={{ ...persistOptions }}
		>
			<RouterProvider router={router} />
		</PersistQueryClientProvider>
	</React.StrictMode>,
);
