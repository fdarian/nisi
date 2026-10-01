import { Link, useLocation } from "@tanstack/react-router";
import { BellIcon, ChevronLeftIcon, SettingsIcon } from "lucide-react";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "#/components/ui/sidebar";

export function SettingsSidebar(): React.ReactElement {
	const pathname = useLocation({ select: (location) => location.pathname });
	return (
		<Sidebar variant="inset">
			<SidebarHeader
				className="h-10 justify-center pl-[78px]"
				data-tauri-drag-region
			>
				<Link
					className="inline-flex w-fit items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
					to="/"
				>
					<ChevronLeftIcon className="size-4" />
					Back to app
				</Link>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Preferences</SidebarGroupLabel>
					<SidebarGroupContent>
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={
										pathname === "/settings" || pathname === "/settings/"
									}
									render={
										<Link to="/settings" activeOptions={{ exact: true }} />
									}
								>
									<SettingsIcon />
									General
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={pathname === "/settings/notifications"}
									render={<Link to="/settings/notifications" />}
								>
									<BellIcon />
									Notifications
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}
