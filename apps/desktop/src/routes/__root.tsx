import { createRootRoute, Outlet } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { useSettingsShortcut } from "#/hooks/use-settings-shortcut";
import { BackendProvider } from "#/lib/backend-context";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	useSettingsShortcut();

	return (
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem>
			<BackendProvider>
				<Outlet />
			</BackendProvider>
		</ThemeProvider>
	);
}
