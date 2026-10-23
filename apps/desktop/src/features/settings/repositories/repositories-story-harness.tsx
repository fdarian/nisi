import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
	useParams,
} from "@tanstack/react-router";
import { useMemo } from "react";
import { BackendContext } from "#/infra/backend-context";
import type { NativeApi } from "#/infra/native";
import {
	createMockSidecarClient,
	type MockOrpcData,
} from "../../../../.storybook/mock-orpc";
import { SettingsShell } from "../settings-shell";
import { RepositoriesPage } from "./repositories-page";
import { RepositoryDetailPage } from "./repository-detail-page";

export const STORY_HOME_DIR = "/Users/farrel";

function unstubbed(method: string): () => never {
	return () => {
		throw new Error(`${method} is not stubbed in this story`);
	};
}

const REPOSITORIES_NATIVE_STUB: NativeApi = {
	getBackend: unstubbed("getBackend"),
	listAvailableEditors: unstubbed("listAvailableEditors"),
	openInEditor: unstubbed("openInEditor"),
	pickFolder: async () => `${STORY_HOME_DIR}/code/picked/repository`,
	sendNotification: unstubbed("sendNotification"),
	openUrl: unstubbed("openUrl"),
	revealInFinder: async () => undefined,
	homeDir: async () => STORY_HOME_DIR,
	exit: unstubbed("exit"),
	closeWindow: unstubbed("closeWindow"),
	setWindowGlass: unstubbed("setWindowGlass"),
	setThemeSource: unstubbed("setThemeSource"),
	onMenu: unstubbed("onMenu"),
	takePendingDeepLinks: unstubbed("takePendingDeepLinks"),
	onDeepLink: unstubbed("onDeepLink"),
};

/**
 * Stubs the native bridge these pages call (`homeDir`, `pickFolder`,
 * `revealInFinder`) so `useHomeDir` runs. Use as a story `beforeEach`; the
 * returned cleanup removes it so other stories keep seeing a plain browser.
 */
export function stubNativeForRepositories(): () => void {
	window.nisi = REPOSITORIES_NATIVE_STUB;
	return () => {
		delete window.nisi;
	};
}

function DetailRoute(): React.ReactElement {
	const params = useParams({ strict: false });
	return (
		<RepositoryDetailPage
			owner={String(params.owner)}
			repo={String(params.repo)}
		/>
	);
}

function createHarnessRouter(initialPath: string) {
	const rootRoute = createRootRoute({
		component: () => (
			<SettingsShell>
				<Outlet />
			</SettingsShell>
		),
	});
	const page = (path: string, component: () => React.ReactNode) =>
		createRoute({ getParentRoute: () => rootRoute, path, component });
	const placeholder = () => <div />;
	return createRouter({
		routeTree: rootRoute.addChildren([
			page("/", placeholder),
			page("/settings", placeholder),
			page("/settings/notifications", placeholder),
			page("/settings/repositories", RepositoriesPage),
			page("/settings/repositories/$owner/$repo", DetailRoute),
		]),
		history: createMemoryHistory({ initialEntries: [initialPath] }),
	});
}

/**
 * The real settings shell, sidebar and Repositories pages, routed by an
 * in-memory router and fed by the mocked sidecar — so a story is the actual
 * `/settings/repositories…` route, not a re-implementation of it.
 */
export function RepositoriesStory(props: {
	data: MockOrpcData;
	initialPath: string;
}): React.ReactElement {
	const backend = useMemo(() => {
		const client = createMockSidecarClient(props.data);
		return {
			status: "ready" as const,
			backend: { port: 0, token: "storybook" },
			orpc: createTanstackQueryUtils(client),
			client,
		};
	}, [props.data]);
	const router = useMemo(
		() => createHarnessRouter(props.initialPath),
		[props.initialPath],
	);
	return (
		<BackendContext value={backend}>
			<RouterProvider router={router} />
		</BackendContext>
	);
}
