"use client";

import { Link } from "@tanstack/react-router";
import {
	AlertTriangleIcon,
	ChevronLeftIcon,
	MonitorIcon,
	MoonIcon,
	RefreshCwIcon,
	SettingsIcon,
	SunIcon,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback } from "react";
import { Button } from "#/components/ui/button";
import {
	Card,
	CardAction,
	CardContent,
	CardHeader,
	CardTitle,
} from "#/components/ui/card";
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
 * nested inside it, with its own `SidebarProvider` (rheya's pattern). Gates
 * on the sidecar connection the same way `AppShell` does, since the
 * Harnesses section reads/writes through it.
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
	action,
	children,
}: {
	title: string;
	action?: React.ReactNode;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<Card>
			<CardHeader>
				<CardTitle>{title}</CardTitle>
				{action !== undefined && <CardAction>{action}</CardAction>}
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

/** Why a harness's checkbox is disabled here — mirrors `EnableHarnessesPanel`'s onboarding-gate reason. */
const UNAVAILABLE_REASON = "Not found on PATH or common install locations.";

/**
 * Checkboxes for the four harnesses, written straight through
 * `settings.update` — `walkthrough.harnesses()` already reflects this same
 * field server-side (its `HarnessInfo.enabled`), so toggling here immediately
 * changes which harnesses show up in the walkthrough tab's model combobox.
 * Renders `useHarnesses`' own result directly rather than a separate static
 * list — `walkthrough.harnesses()` always reports all four regardless of
 * which are currently enabled, so there's no risk of a disabled harness being
 * impossible to re-enable from here.
 *
 * A harness's checkbox is disabled when `!harness.available` (its CLI isn't
 * on disk right now — a live check, see `HarnessInfo`'s doc), with a reason
 * so the row still reads as "install this to use it" rather than "broken."
 * An already-*enabled* harness that's since gone unavailable isn't silently
 * dropped from `enabledHarnesses` — its checkbox stays checked (and
 * disabled, so it can't be re-toggled without becoming available again) and
 * an inline warning explains why, so re-plugging in the same CLI later needs
 * no reconfiguration.
 *
 * The refresh button re-runs both the availability check and (for
 * enabled+available harnesses) model discovery, bypassing
 * `model-discovery.ts`'s cache — for a harness installed while nisi was
 * already open.
 */
function HarnessesSection({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const { harnesses, refresh, isRefreshing } = useHarnesses(orpc);
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
		<SettingsSection
			action={
				<Button
					aria-label="Refresh harnesses"
					loading={isRefreshing}
					onClick={refresh}
					size="icon-sm"
					variant="ghost"
				>
					<RefreshCwIcon />
				</Button>
			}
			title="Harnesses"
		>
			{harnesses.map((harness) => (
				<SettingsRow
					description={
						!harness.available
							? UNAVAILABLE_REASON
							: "Drive this harness's local CLI when generating a walkthrough."
					}
					key={harness.id}
					title={harness.label}
				>
					<div className="flex items-center gap-2">
						{harness.enabled && !harness.available && (
							<span
								className="flex items-center gap-1 text-warning-foreground text-xs"
								title="Enabled, but its CLI isn't currently found — reconnect it or refresh."
							>
								<AlertTriangleIcon className="size-3.5" />
								Missing
							</span>
						)}
						<Checkbox
							checked={harness.enabled}
							disabled={!harness.available}
							onCheckedChange={(checked) =>
								toggleHarness(harness.id, checked === true)
							}
						/>
					</div>
				</SettingsRow>
			))}
		</SettingsSection>
	);
}
