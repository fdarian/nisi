"use client";

import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";
import { useTheme } from "next-themes";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "#/components/ui/toggle-group";
import type { SidecarQueryUtils } from "#/infra/backend-context";
import { useBackendContext } from "#/infra/backend-context";
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
