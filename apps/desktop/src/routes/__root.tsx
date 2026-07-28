import { createRootRoute, Outlet } from "@tanstack/react-router";
import { BackendProvider } from "#/lib/backend-context";

export const Route = createRootRoute({
	component: RootLayout,
});

function RootLayout() {
	return (
		<BackendProvider>
			<Outlet />
		</BackendProvider>
	);
}
