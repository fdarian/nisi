import "./index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import React from "react";
import ReactDOM from "react-dom/client";
import { startDeepLinkListener } from "#/lib/deep-link-store";
import { routeTree } from "./routeTree.gen";

// Boot-once, before anything renders — a `nisi://` link can arrive before
// the webview exists or React mounts. See `deep-link-store.ts`'s doc
// comment for why this must never run again after this call.
void startDeepLinkListener();

const router = createRouter({ routeTree });
// The sidecar's `events.subscribe` stream (session-opened/closed,
// session-files-changed) is this app's freshness mechanism — a blanket
// window-refocus refetch of every query would be redundant on top of that,
// and would defeat the Files Changed tab's manual-refresh gate
// (`useLiveFileChanges`, `src/lib/pr-data.ts`), which deliberately holds
// pending changes behind the user's click rather than auto-invalidating.
// Files Changed gets a scoped, deliberate exception instead —
// `useRefreshOnWatchedEdge` (`src/lib/pr-data.ts`) refetches it specifically
// on regaining focus while it's the visible tab, reusing the same `refresh`
// the gate's button calls, so this global default stays off.
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
		<QueryClientProvider client={queryClient}>
			<RouterProvider router={router} />
		</QueryClientProvider>
	</React.StrictMode>,
);
