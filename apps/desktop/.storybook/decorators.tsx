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
 * settings page. One router is built per story render (`useMemo`), each
 * wrapping that story's own children as its index route's component.
 */
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
import { useMemo } from "react";

// Stories should never actually hit the network — a query that somehow
// misses `createMockOrpc`'s coverage should surface as a visibly stuck
// loading state, not retry silently for seconds first.
const STORY_QUERY_CONFIG: QueryClientConfig = {
	defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
};

function createStoryRouter(content: React.ReactNode) {
	const rootRoute = createRootRoute({ component: () => <Outlet /> });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: "/",
		component: () => content,
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
	const router = useMemo(() => createStoryRouter(children), [children]);

	return (
		<ThemeProvider
			attribute="class"
			defaultTheme="system"
			enableSystem
			forcedTheme={theme === "system" ? undefined : theme}
		>
			<QueryClientProvider client={queryClient}>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</ThemeProvider>
	);
}
