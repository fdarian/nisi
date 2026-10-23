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
import type { RefCallback } from "react";
import { FluidHoverHighlight, useFluidHover } from "#/components/fluid-hover";
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
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { useSettings } from "./settings-data";
import { useNativeGlassShowing } from "./window-glass";

export function SettingsSidebar(): React.ReactElement {
	const pathname = useLocation({ select: (location) => location.pathname });
	const backend = useBackendContext();
	const glassShowing = useNativeGlassShowing();
	const hover = useFluidHover<HTMLUListElement>("y");
	// Glass draws the fluid highlight instead of each button's own hover fill; the lit active button drops its fill so the two don't stack.
	const buttonClassName = glassShowing
		? "hover:bg-transparent group-data-[fluid-hover-active]/menu-item:data-[active=true]:bg-transparent"
		: undefined;
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
						<SidebarMenu
							className="relative"
							ref={hover.containerRef}
							{...(glassShowing ? hover.handlers : {})}
						>
							{glassShowing && (
								<FluidHoverHighlight
									className="rounded-lg bg-sidebar-accent"
									hover={hover}
								/>
							)}
							<SidebarMenuItem ref={hover.registerItem}>
								<SidebarMenuButton
									className={buttonClassName}
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
							<SidebarMenuItem ref={hover.registerItem}>
								<SidebarMenuButton
									className={buttonClassName}
									isActive={pathname === "/settings/notifications"}
									render={<Link to="/settings/notifications" />}
								>
									<BellIcon />
									Notifications
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem ref={hover.registerItem}>
								<SidebarMenuButton
									className={buttonClassName}
									isActive={pathname === "/settings/feature-flags"}
									render={<Link to="/settings/feature-flags" />}
								>
									<FlagIcon />
									Feature Flags
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem ref={hover.registerItem}>
								<SidebarMenuButton
									className={buttonClassName}
									isActive={pathname === "/settings/agents"}
									render={<Link to="/settings/agents" />}
								>
									<AsteriskIcon />
									Agents
								</SidebarMenuButton>
							</SidebarMenuItem>
							{backend.status === "ready" && (
								<PublicAccessEntry
									buttonClassName={buttonClassName}
									orpc={backend.orpc}
									pathname={pathname}
									registerHoverItem={hover.registerItem}
								/>
							)}
							<SidebarMenuItem ref={hover.registerItem}>
								<SidebarMenuButton
									className={buttonClassName}
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

function PublicAccessEntry(props: {
	buttonClassName: string | undefined;
	orpc: SidecarQueryUtils;
	pathname: string;
	registerHoverItem: RefCallback<HTMLElement>;
}): React.ReactElement | null {
	const settings = useSettings(props.orpc).settings;
	if (!settings.publicAccessFeatureEnabled) return null;
	return (
		<SidebarMenuItem ref={props.registerHoverItem}>
			<SidebarMenuButton
				className={props.buttonClassName}
				isActive={props.pathname === "/settings/public-access"}
				render={<Link to="/settings/public-access" />}
			>
				<GlobeIcon />
				Public Access
			</SidebarMenuButton>
		</SidebarMenuItem>
	);
}
