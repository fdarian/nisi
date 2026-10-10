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
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useMemo } from "react";
import { BackendContext } from "#/infra/backend-context";
import {
	createMockSidecarClient,
	type MockOrpcData,
} from "../../../../.storybook/mock-orpc";
import { SettingsShell } from "../settings-shell";
import { RepositoriesPage } from "./repositories-page";
import { RepositoryDetailPage } from "./repository-detail-page";

export const STORY_HOME_DIR = "/Users/farrel";

/**
 * Stubs the Tauri calls these pages make (`homeDir`, `pick_folder`,
 * `revealItemsInDir`) and marks the webview as Tauri so `useHomeDir` runs.
 * Use as a story `beforeEach`; the returned cleanup restores the globals so
 * other stories keep seeing a plain browser.
 */
export function stubTauriForRepositories(): () => void {
	const tauriGlobal = globalThis as { isTauri?: boolean };
	tauriGlobal.isTauri = true;
	mockIPC((command) => {
		switch (command) {
			case "plugin:path|resolve_directory":
				return STORY_HOME_DIR;
			case "pick_folder":
				return `${STORY_HOME_DIR}/code/picked/repository`;
			default:
				return undefined;
		}
	});
	return () => {
		clearMocks();
		delete tauriGlobal.isTauri;
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
