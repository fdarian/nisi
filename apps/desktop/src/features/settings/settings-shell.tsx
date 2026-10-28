import { InsetPane } from "#/components/inset-pane";
import { SidebarProvider } from "#/components/ui/sidebar";
import { SettingsSidebar } from "./settings-sidebar";

/** The settings chrome: sidebar plus the inset panel a settings page renders into. */
export function SettingsShell(props: {
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<SidebarProvider className="h-screen overflow-hidden">
			<SettingsSidebar />
			<InsetPane className="ms-0">{props.children}</InsetPane>
		</SidebarProvider>
	);
}
