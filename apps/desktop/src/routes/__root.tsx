import { createRootRoute, Outlet } from "@tanstack/react-router";
import { Agentation } from "agentation";
import { ThemeProvider } from "next-themes";
import {
	DevToolProvider,
	useAgentationEnabled,
} from "#/components/devtool/dev-tool-context";
import { ToastProvider } from "#/components/ui/toast";
import { useSettingsShortcut } from "#/hooks/use-settings-shortcut";
import { BackendProvider } from "#/lib/backend-context";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	useSettingsShortcut();

	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<DevToolProvider>
				<ToastProvider>
					<BackendProvider>
						<Outlet />
						{import.meta.env.DEV ? <AgentationToggle /> : null}
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
