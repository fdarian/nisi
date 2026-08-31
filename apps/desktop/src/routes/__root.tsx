import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Agentation } from "agentation";
import { Mesurer } from "mesurer";
import { ThemeProvider } from "next-themes";
import {
	DevToolProvider,
	useAgentationEnabled,
	useMesurerEnabled,
} from "#/components/devtool/dev-tool-context";
import { ToastProvider } from "#/components/ui/toast";
import { useSettingsShortcut } from "#/hooks/use-settings-shortcut";
import { BackendProvider } from "#/lib/backend-context";
import { useRedirectHomeOnPendingDeepLink } from "#/lib/deep-link-data";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	useSettingsShortcut();
	// `AppShellReady` (where `useDeepLinkOpener` actually opens a pending
	// link) only renders on `/` — this is what gets a link that arrived
	// while `/settings` was showing back to a route that can see it. See
	// `deep-link-data.ts`'s doc comment for why this can't live there
	// instead.
	useRedirectHomeOnPendingDeepLink();

	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<DevToolProvider>
				<ToastProvider>
					<BackendProvider>
						<Outlet />
						<AgentationToggle />
						<MesurerToggle />
					</BackendProvider>
				</ToastProvider>
			</DevToolProvider>
		</ThemeProvider>
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
