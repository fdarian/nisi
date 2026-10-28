"use client";

import { ChevronRightIcon, MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Collapsible,
	CollapsiblePanel,
	CollapsibleTrigger,
} from "#/components/ui/collapsible";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { Slider } from "#/components/ui/slider";
import { Switch } from "#/components/ui/switch";
import { Tabs, TabsList, TabsTab } from "#/components/ui/tabs";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
import { hasNative } from "#/infra/native";
import { useAvailableEditors } from "#/infra/use-available-editors";
import { DiffThemeColumn } from "./diff-theme-picker";
import {
	useDiffThemeDark,
	useDiffThemeLight,
	usePreferredEditor,
} from "./settings-data";
import {
	SettingsRow,
	SettingsRowHeader,
	SettingsSection,
} from "./settings-section";
import {
	GLASS_TRANSLUCENCY_MAX,
	GLASS_TRANSLUCENCY_MIN,
	GLASS_TRANSLUCENCY_STEP,
	type GlassLayer,
	type GlassScope,
	isGlassModified,
	resetGlass,
	resolveGlassLayers,
	setGlassLayer,
	setGlassTranslucency,
	setWindowGlassEnabled,
	useGlassTranslucency,
	useWindowGlassEnabled,
} from "./window-glass";

export function SettingsPage(): React.ReactElement | null {
	const backend = useBackendContext();
	if (backend.status !== "ready") return null;
	return <SettingsContent orpc={backend.orpc} />;
}

function SettingsContent({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	return (
		<div className="mx-auto flex w-full max-w-2xl flex-col gap-6 overflow-y-auto px-8 py-12">
			<h1 className="font-semibold text-2xl tracking-tight">General</h1>
			<AppearanceSection orpc={orpc} />
		</div>
	);
}

/**
 * Same header as `SettingsRow`, but `children` render as a full-width block
 * beneath it instead of beside it — for a row whose content can't fit
 * inline (the Diff theme row's two-column select+preview grid below). A
 * second component sharing `SettingsRowHeader` rather than a layout prop on
 * `SettingsRow`: the two containers don't share a shape, one is
 * `items-center justify-between` (title and children side by side), this is
 * `flex-col` (title, then children underneath).
 */
function SettingsRowStacked({
	title,
	description,
	children,
}: {
	title: string;
	description: string;
	children: React.ReactNode;
}): React.ReactElement {
	return (
		<div className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
			<SettingsRowHeader description={description} title={title} />
			{children}
		</div>
	);
}

const THEME_PREFERENCES = ["light", "dark", "system"] as const;
type ThemePreference = (typeof THEME_PREFERENCES)[number];

const isThemePreference = (value: string): value is ThemePreference =>
	(THEME_PREFERENCES as readonly string[]).includes(value);

/** Sentinel `Select` value for "no preferred editor chosen" — `preferredEditor` itself stores `null` for that state, but Base UI's `Select` needs a concrete item value to render as selected. */
const NO_PREFERRED_EDITOR = "none";

function AppearanceSection({
	orpc,
}: {
	orpc: SidecarQueryUtils;
}): React.ReactElement {
	const { theme, setTheme } = useTheme();
	const [preferredEditor, setPreferredEditor] = usePreferredEditor(orpc);
	const { editors, loadEditors } = useAvailableEditors();
	const [diffThemeLight, setDiffThemeLight] = useDiffThemeLight(orpc);
	const [diffThemeDark, setDiffThemeDark] = useDiffThemeDark(orpc);

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
			{hasNative() && <WindowGlassGroup />}
			<SettingsRowStacked
				description="Syntax colors for the diff view — one theme per appearance."
				title="Diff theme"
			>
				<div className="grid grid-cols-2 gap-4">
					<DiffThemeColumn
						onValueChange={setDiffThemeLight}
						pin="light"
						value={diffThemeLight}
					/>
					<DiffThemeColumn
						onValueChange={setDiffThemeDark}
						pin="dark"
						value={diffThemeDark}
					/>
				</div>
			</SettingsRowStacked>
			<SettingsRow
				description="Press o, then e, to open the selected file in this editor."
				title="Preferred editor"
			>
				<Select
					items={[
						{ value: NO_PREFERRED_EDITOR, label: "None" },
						...editors.map((editor) => ({
							value: editor.id,
							label: editor.name,
						})),
					]}
					onOpenChange={(open) => {
						if (open) loadEditors();
					}}
					onValueChange={(value: string | null) =>
						setPreferredEditor(
							value === null || value === NO_PREFERRED_EDITOR ? null : value,
						)
					}
					value={preferredEditor ?? NO_PREFERRED_EDITOR}
				>
					<SelectTrigger className="w-40" size="sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value={NO_PREFERRED_EDITOR}>None</SelectItem>
						{editors.map((editor) => (
							<SelectItem key={editor.id} value={editor.id}>
								{editor.name}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</SettingsRow>
		</SettingsSection>
	);
}

const GLASS_SCOPES: ReadonlyArray<{ value: GlassScope; label: string }> = [
	{ value: "both", label: "Both" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

const isGlassScope = (value: unknown): value is GlassScope =>
	GLASS_SCOPES.some((scope) => scope.value === value);

/** One group, not two rows: the switch and its advanced controls share a section, so no divider falls between them. */
function WindowGlassGroup(): React.ReactElement {
	const enabled = useWindowGlassEnabled();
	return (
		<Collapsible className="group/advanced py-3">
			<div className="flex items-center justify-between gap-6">
				<SettingsRowHeader title="Liquid glass" />
				<div className="flex flex-col items-end gap-1">
					<Switch
						aria-label="Liquid glass"
						checked={enabled}
						onCheckedChange={setWindowGlassEnabled}
					/>
					{enabled && (
						<CollapsibleTrigger className="inline-flex items-center gap-0.5 text-muted-foreground text-xs outline-none hover:text-foreground focus-visible:text-foreground">
							<ChevronRightIcon className="size-3 transition-transform group-data-open/advanced:rotate-90" />
							Advanced
						</CollapsibleTrigger>
					)}
				</div>
			</div>
			{enabled && <WindowGlassAdvanced />}
		</Collapsible>
	);
}

function WindowGlassAdvanced(): React.ReactElement {
	const [scope, setScope] = useState<GlassScope>("both");
	const translucency = useGlassTranslucency();

	// In `both`, the sliders show light's values; moving one writes it to both themes.
	const shownTheme = scope === "dark" ? "dark" : "light";
	const shown = translucency[shownTheme];
	const layers = resolveGlassLayers(shownTheme, shown);
	const scopedThemes =
		scope === "both" ? (["light", "dark"] as const) : [scope];
	const isCustom = scopedThemes.some(
		(theme) => translucency[theme].custom !== null,
	);
	const isModified = scopedThemes.some((theme) =>
		isGlassModified(translucency[theme]),
	);

	return (
		<CollapsiblePanel>
			<div className="flex flex-col gap-4 pt-3">
				<Tabs
					onValueChange={(value) => {
						if (isGlassScope(value)) setScope(value);
					}}
					value={scope}
				>
					<TabsList size="sm">
						{GLASS_SCOPES.map((item) => (
							<TabsTab key={item.value} value={item.value}>
								{item.label}
							</TabsTab>
						))}
					</TabsList>
				</Tabs>
				<GlassSliderRow
					disabled={isCustom}
					onChange={(value) => setGlassTranslucency(scope, value)}
					title="Translucency"
					trailing={
						isModified && (
							<Button
								onClick={() => resetGlass(scope)}
								size="xs"
								variant="link"
							>
								Reset
							</Button>
						)
					}
					value={shown.translucency}
				/>
				<GlassLayerRow
					layer="frame"
					layers={layers}
					scope={scope}
					title="Frame"
				/>
				<GlassLayerRow
					layer="pane"
					layers={layers}
					scope={scope}
					title="Panel"
				/>
			</div>
		</CollapsiblePanel>
	);
}

function GlassLayerRow(props: {
	layer: GlassLayer;
	layers: Record<GlassLayer, number>;
	scope: GlassScope;
	title: string;
}): React.ReactElement {
	return (
		<GlassSliderRow
			disabled={false}
			onChange={(value) => setGlassLayer(props.scope, props.layer, value)}
			title={props.title}
			value={props.layers[props.layer]}
		/>
	);
}

function GlassSliderRow(props: {
	title: string;
	description?: string;
	value: number;
	disabled: boolean;
	onChange: (value: number) => void;
	trailing?: React.ReactNode;
}): React.ReactElement {
	return (
		<SettingsRow
			className="py-0"
			description={props.description}
			title={props.title}
		>
			<div className="flex items-center gap-3">
				{props.trailing}
				<Slider
					aria-label={props.title}
					className="w-40"
					disabled={props.disabled}
					max={GLASS_TRANSLUCENCY_MAX}
					min={GLASS_TRANSLUCENCY_MIN}
					onValueChange={(value) => {
						if (typeof value === "number") props.onChange(value);
					}}
					step={GLASS_TRANSLUCENCY_STEP}
					value={props.value}
				/>
			</div>
		</SettingsRow>
	);
}
