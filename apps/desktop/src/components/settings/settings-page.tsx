"use client";

import { Link } from "@tanstack/react-router";
import {
	AlertTriangleIcon,
	ChevronLeftIcon,
	MonitorIcon,
	MoonIcon,
	SettingsIcon,
	SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "#/components/ui/card";
import { Checkbox } from "#/components/ui/checkbox";
import {
	Empty,
	EmptyDescription,
	EmptyMedia,
	EmptyTitle,
} from "#/components/ui/empty";
import {
	Sidebar,
	SidebarContent,
	SidebarGroup,
	SidebarGroupContent,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
} from "#/components/ui/sidebar";
import { Spinner } from "#/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import type { SidecarQueryUtils } from "#/lib/backend-context";
import { useBackendContext } from "#/lib/backend-context";
import { useUpdateSettings } from "#/lib/settings-data";
import { type HarnessId, useHarnesses } from "#/lib/walkthrough-data";

/**
 * Top-level `/settings` route content — a sibling of the main `AppShell`, not
 * nested inside it, with its own `SidebarProvider` (rheya's pattern, see
 * PLAN.md Phase 4). Gates on the sidecar connection the same way `AppShell`
 * does, since the Harnesses section reads/writes through it.
 */
export function SettingsPage(): React.ReactElement {
	const backend = useBackendContext();

	if (backend.status === "loading") {
		return (
			<SettingsFrame>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<Spinner className="size-5" />
					</EmptyMedia>
					<EmptyTitle>Connecting to sidecar…</EmptyTitle>
				</Empty>
			</SettingsFrame>
		);
	}

	if (backend.status === "error") {
		return (
			<SettingsFrame>
				<Empty className="flex-1">
					<EmptyMedia variant="icon">
						<AlertTriangleIcon />
					</EmptyMedia>
					<EmptyTitle>Couldn't reach the sidecar</EmptyTitle>
					<EmptyDescription>{backend.message}</EmptyDescription>
				</Empty>
			</SettingsFrame>
		);
	}

	return (
		<SettingsFrame>
			<SettingsContent orpc={backend.orpc} />
		</SettingsFrame>
	);
}

/**
 * The macOS overlay titlebar (`titleBarStyle: "Overlay"` + `hiddenTitle`)
 * applies here too — no native title bar remains to drag by, and the traffic
 * lights float over the top-left corner, so the sidebar header reserves space
 * for them and marks itself as a Tauri drag region, same as `PrTabStrip`.
 */
function SettingsFrame({
	children,
}: {
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<SidebarProvider className="h-screen overflow-hidden">
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
									<SidebarMenuButton isActive>
										<SettingsIcon />
										General
									</SidebarMenuButton>
								</SidebarMenuItem>
							</SidebarMenu>
						</SidebarGroupContent>
					</SidebarGroup>
				</SidebarContent>
			</Sidebar>
			<SidebarInset className="flex flex-col">{children}</SidebarInset>
		</SidebarProvider>
	);
}

function SettingsContent({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">Settings</h1>
			<AppearanceSection />
			<HarnessesSection orpc={orpc} />
		</div>
	);
}

function SettingsSection({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
			</CardHeader>
			<CardContent className="flex flex-col divide-y divide-border">
				{children}
			</CardContent>
		</Card>
	);
}

function SettingsRow({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex items-center justify-between gap-6 py-3 first:pt-0 last:pb-0">
			<div className="flex flex-col gap-0.5">
				<span className="font-medium text-foreground text-sm">{title}</span>
				<span className="text-muted-foreground text-sm">{description}</span>
			</div>
			{children}
		</div>
	);
}

const THEME_PREFERENCES = ["light", "dark", "system"] as const;
type ThemePreference = (typeof THEME_PREFERENCES)[number];

const isThemePreference = (value: string): value is ThemePreference =>
	(THEME_PREFERENCES as readonly string[]).includes(value);

function AppearanceSection(): React.ReactElement {
	const { theme, setTheme } = useTheme();

	return (
		<SettingsSection title="Appearance">
			<SettingsRow
				description="Match your system, or pin light/dark."
				title="Theme"
			>
				<ToggleGroup
					onValueChange={(value) => {
						const next = value[0];
						if (next !== undefined && isThemePreference(next)) setTheme(next);
					}}
					size="sm"
					value={theme !== undefined ? [theme] : []}
					variant="outline"
				>
					<ToggleGroupItem aria-label="Light" value="light">
						<SunIcon />
					</ToggleGroupItem>
					<ToggleGroupItem aria-label="Dark" value="dark">
						<MoonIcon />
					</ToggleGroupItem>
					<ToggleGroupItem aria-label="System" value="system">
						<MonitorIcon />
					</ToggleGroupItem>
				</ToggleGroup>
			</SettingsRow>
		</SettingsSection>
	);
}

/**
 * Checkboxes for the four harnesses, written straight through
 * `settings.update` — `walkthrough.harnesses()` already reflects this same
 * field server-side (its `HarnessInfo.enabled`), so toggling here immediately
 * changes which harnesses show up in the walkthrough tab's model combobox.
 * Renders `useHarnesses`' own result directly rather than a separate static
 * list — `walkthrough.harnesses()` always reports all four regardless of
 * which are currently enabled, so there's no risk of a disabled harness being
 * impossible to re-enable from here.
 */
function HarnessesSection({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const { harnesses } = useHarnesses(orpc);
	const update = useUpdateSettings(orpc);

	const toggleHarness = useCallback(
		(id: HarnessId, checked: boolean) => {
			const currentlyEnabled = harnesses
				.filter((harness) => harness.enabled)
				.map((harness) => harness.id);
			const next = checked
				? Array.from(new Set([...currentlyEnabled, id]))
				: currentlyEnabled.filter((enabled) => enabled !== id);
			update({ enabledHarnesses: next });
		},
		[harnesses, update],
	);

	return (
		<SettingsSection title="Harnesses">
			{harnesses.map((harness) => (
				<SettingsRow
					description="Drive this harness's local CLI when generating a walkthrough."
					key={harness.id}
					title={harness.label}
				>
					<Checkbox
						checked={harness.enabled}
						onCheckedChange={(checked) =>
							toggleHarness(harness.id, checked === true)
						}
					/>
				</SettingsRow>
			))}
		</SettingsSection>
	);
}
