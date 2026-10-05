/**
 * The provider stack every story needs, matching the real app's
 * (`src/main.tsx`, `src/routes/__root.tsx`) minus `BackendProvider` — stories
 * never call `invoke("get_backend")`, they pass a `createMockOrpc(...)`
 * result straight to the component under test instead.
 *
 * The preview follows the OS `prefers-color-scheme` by default — the same
 * signal Storybook's own manager theme defaults to (`create()` with no
 * args) — so stories match the surrounding UI without a bridge. The `theme`
 * toolbar global (`globalTypes`/`initialGlobals` in `preview.tsx`) exists
 * only to force one theme for review. `next-themes`' `ThemeProvider` still
 * drives the actual switch via `forcedTheme` — `attribute="class"` sets the
 * same `.dark` Tailwind variant (`src/index.css`) the real app uses, so it's
 * a real rendering difference, not a cosmetic label.
 *
 * A `RouterProvider` is here only so `<Link to="/settings">`
 * (`generate-panel.tsx`) has a router context to call into — its route tree
 * is just enough to register `/settings` as a valid target, not a working
 * settings page. The router stays mounted across args updates; story content
 * travels through React context so updates don't replace the route tree.
 */

import type { Decorator } from "@storybook/react-vite";
import type { QueryClientConfig } from "@tanstack/react-query";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { createContext, useContext, useMemo } from "react";
import { ToastProvider } from "#/components/ui/toast";
import { ChatProvider } from "#/features/chat/chat-store";
import { DevToolProvider } from "#/features/devtools/dev-tool-context";
import { SessionUiProvider } from "#/features/pull-request/data/session-ui-store";
import { SidecarEventsProvider } from "#/infra/sidecar-events";
import { AppViewActiveContext } from "#/shell/app-view-context";
import { createMockSidecarClient } from "./mock-orpc";

// Stories should never actually hit the network — a query that somehow
// misses `createMockOrpc`'s coverage should surface as a visibly stuck
// loading state, not retry silently for seconds first.
const STORY_QUERY_CONFIG: QueryClientConfig = {
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
};

const storyClient = createMockSidecarClient();

export const withAppShellProviders: Decorator = (Story) => (
	<DevToolProvider>
		<ToastProvider>
			<SidecarEventsProvider client={storyClient}>
				<AppViewActiveContext value={true}>
					<SessionUiProvider>
						<ChatProvider>
							<Story />
						</ChatProvider>
					</SessionUiProvider>
				</AppViewActiveContext>
			</SidecarEventsProvider>
		</ToastProvider>
	</DevToolProvider>
);

export function StoryQueryBoundary(props: {
	children: React.ReactNode;
}): React.ReactElement {
	const queryClient = useMemo(() => new QueryClient(STORY_QUERY_CONFIG), []);
	return (
		<QueryClientProvider client={queryClient}>
			{props.children}
		</QueryClientProvider>
	);
}

const StoryContentContext = createContext<React.ReactNode>(null);

function StoryContent() {
	return useContext(StoryContentContext);
}

function createStoryRouter() {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: StoryContent,
	});
	const settingsRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/settings",
		component: () => (
			<p className="p-6 text-muted-foreground text-sm">
				Settings isn't part of this story — this route only exists so `&lt;Link
				to="/settings"&gt;` has somewhere to point.
			</p>
		),
	});
	return createRouter({
		routeTree: rootRoute.addChildren([indexRoute, settingsRoute]),
		history: createMemoryHistory({ initialEntries: ["/"] }),
	});
}

export type StoryTheme = "system" | "light" | "dark";

export function StoryProviders({
	children,
	theme,
}: {
	children: React.ReactNode;
	theme: StoryTheme;
}): React.ReactElement {
	// One `QueryClient` per story render — sharing one across stories would
	// leak a previous story's cached query results into the next.
	const queryClient = useMemo(() => new QueryClient(STORY_QUERY_CONFIG), []);
	const router = useMemo(() => createStoryRouter(), []);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			forcedTheme={theme === "system" ? undefined : theme}
		>
			<QueryClientProvider client={queryClient}>
				<StoryContentContext value={children}>
					<RouterProvider router={router} />
				</StoryContentContext>
			</QueryClientProvider>
		</ThemeProvider>
	);
}
