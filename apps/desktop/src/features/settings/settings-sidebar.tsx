import { Link, useLocation } from "@tanstack/react-router";
import {
	AsteriskIcon,
	BellIcon,
	ChevronLeftIcon,
	FlagIcon,
	GitForkIcon,
	GlobeIcon,
	SettingsIcon,
} from "lucide-react";
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
			<SidebarHeader className="app-drag h-10 justify-center pl-[78px]">
				<Link
					className="app-no-drag inline-flex w-fit items-center gap-1 text-muted-foreground text-sm transition-colors hover:text-foreground"
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
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={pathname === "/settings/feature-flags"}
									render={<Link to="/settings/feature-flags" />}
								>
									<FlagIcon />
									Feature Flags
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={pathname === "/settings/agents"}
									render={<Link to="/settings/agents" />}
								>
									<AsteriskIcon />
									Agents
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={pathname === "/settings/public-access"}
									render={<Link to="/settings/public-access" />}
								>
									<GlobeIcon />
									Public Access
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={pathname.startsWith("/settings/repositories")}
									render={<Link to="/settings/repositories" />}
								>
									<GitForkIcon />
									Repositories
								</SidebarMenuButton>
							</SidebarMenuItem>
						</SidebarMenu>
					</SidebarGroupContent>
				</SidebarGroup>
			</SidebarContent>
		</Sidebar>
	);
}
