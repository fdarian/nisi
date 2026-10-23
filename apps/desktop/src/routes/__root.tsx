import {
	createRootRoute,
	Outlet,
	useRouterState,
} from "@tanstack/react-router";
import { Agentation } from "agentation";
import { Mesurer } from "mesurer";
import { ThemeProvider, useTheme } from "next-themes";
import { useEffect } from "react";
import { ToastProvider } from "#/components/ui/toast";
import {
	DevToolProvider,
	useAgentationEnabled,
	useMesurerEnabled,
} from "#/features/devtools/dev-tool-context";
import { DiffWorkerPrewarm } from "#/features/diff/viewer/diff-code-view";
import { ScheduledMergeNotifications } from "#/features/pull-request/merge/scheduled-merge-notifications";
import { useSettingsShortcut } from "#/features/settings/use-settings-shortcut";
import { BackendProvider, useBackendContext } from "#/infra/backend-context";
import { hasNative, native } from "#/infra/native";
import { SidecarEventsProvider } from "#/infra/sidecar-events";
import { AppShell } from "#/shell/app-shell";
import { AppViewActiveContext } from "#/shell/app-view-context";
import { useRedirectHomeOnPendingDeepLink } from "#/shell/deep-link/deep-link-data";
import { OpenRequestProvider } from "#/shell/open-request/open-request-data";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	useSettingsShortcut();
	useRedirectHomeOnPendingDeepLink();

	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<NativeThemeSync />
			<DevToolProvider>
				<ToastProvider>
					<BackendProvider>
						<ConnectedEvents />
					</BackendProvider>
				</ToastProvider>
			</DevToolProvider>
		</ThemeProvider>
	);
}

/** Glass renders in the native appearance, so it has to track the app's pinned theme rather than the system's. */
function NativeThemeSync(): null {
	const themeState = useTheme();
	const theme = themeState.theme;
	useEffect(() => {
		if (!hasNative() || theme === undefined) return;
		if (theme !== "light" && theme !== "dark" && theme !== "system") {
			throw new Error(`unexpected theme: ${theme}`);
		}
		void native().setThemeSource(theme);
	}, [theme]);
	return null;
}

function ConnectedEvents() {
	const backend = useBackendContext();
	const appViewActive = useRouterState({
		select: (state) => state.location.pathname === "/",
	});
	const content = (
		<>
			<AppViewActiveContext value={appViewActive}>
				{/* Keep Pierre's CodeViews and their scroll containers alive across routes. */}
				<div hidden={!appViewActive}>
					<AppShell />
				</div>
			</AppViewActiveContext>
			<Outlet />
			<AgentationToggle />
			<MesurerToggle />
		</>
	);
	if (backend.status !== "ready") return content;
	return (
		<SidecarEventsProvider client={backend.client}>
			<DiffWorkerPrewarm orpc={backend.orpc} />
			<ScheduledMergeNotifications orpc={backend.orpc} />
			<OpenRequestProvider>{content}</OpenRequestProvider>
		</SidecarEventsProvider>
	);
}

function AgentationToggle() {
	const [agentationEnabled] = useAgentationEnabled();
	return agentationEnabled ? <Agentation /> : null;
}

function MesurerToggle() {
	const [mesurerEnabled] = useMesurerEnabled();
	return mesurerEnabled ? <Mesurer /> : null;
}
