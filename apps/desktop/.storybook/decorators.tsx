/**
 * The provider stack every story needs, matching the real app's
 * (`src/main.tsx`, `src/routes/__root.tsx`) minus `BackendProvider` — stories
 * never call `invoke("get_backend")`, they pass a `createMockOrpc(...)`
 * result straight to the component under test instead.
 *
 * The light/dark toggle is a small floating button this component renders
 * itself, not Storybook's own toolbar globals mechanism
 * (`globalTypes`/`initialGlobals` in `preview.tsx`) — a custom toolbar global
 * registers correctly (visible on `storyStoreValue.projectAnnotations` in a
 * console check) but this Storybook version never actually renders a
 * toolbar control for it, silently. Self-rendering the toggle sidesteps that
 * entirely rather than chasing a manager-UI bug. `next-themes`'
 * `ThemeProvider` still drives the actual switch via `forcedTheme` —
 * `attribute="class"` sets the same `.dark` Tailwind variant
 * (`src/index.css`) the real app uses, so it's a real rendering difference,
 * not a cosmetic label.
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
import { useMemo, useState } from "react";

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

type StoryTheme = "light" | "dark";

function ThemeToggle({
	theme,
	onToggle,
}: {
	theme: StoryTheme;
	onToggle: () => void;
}): React.ReactElement {
	return (
		<button
			className="fixed top-2 right-2 z-50 rounded-md border bg-background px-2 py-1 font-medium text-foreground text-xs shadow-sm"
			onClick={onToggle}
			type="button"
		>
			{theme === "light" ? "Switch to dark" : "Switch to light"}
		</button>
	);
}

export function StoryProviders({
	children,
}: {
	children: React.ReactNode;
}): React.ReactElement {
	const [theme, setTheme] = useState<StoryTheme>("light");
	// One `QueryClient` per story render — sharing one across stories would
	// leak a previous story's cached query results into the next.
	const queryClient = useMemo(() => new QueryClient(STORY_QUERY_CONFIG), []);
	const router = useMemo(() => createStoryRouter(children), [children]);

	return (
		<ThemeProvider attribute="class" enableSystem={false} forcedTheme={theme}>
			<QueryClientProvider client={queryClient}>
				<ThemeToggle
					onToggle={() =>
						setTheme((current) => (current === "light" ? "dark" : "light"))
					}
					theme={theme}
				/>
				<RouterProvider router={router} />
			</QueryClientProvider>
		</ThemeProvider>
	);
}
