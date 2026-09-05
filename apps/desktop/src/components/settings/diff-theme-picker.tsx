"use client";

/**
 * The live preview pane under each `Select` in Settings > Appearance > Diff
 * theme (`settings-page.tsx`) — renders `SAMPLE_PATCH` through the chosen
 * theme, pinned to one color scheme regardless of the app's own current
 * appearance (the light column always renders light, the dark column always
 * dark). `themeType` is what pins it: the real diff pane uses `"system"`
 * (`useDiffTheme`), but `wrapThemeCSS` (`@pierre/diffs`'
 * `dist/utils/cssWrappers.js`) only forces `:host { color-scheme: ... }` when
 * `themeType !== "system"` — every token still carries both
 * `--diffs-token-light` and `--diffs-token-dark`, forcing that one `color-scheme`
 * is what makes every `light-dark()` in the shadow root resolve to the pinned
 * side.
 *
 * `disableWorkerPool` renders synchronously on the main thread instead of
 * going through `@pierre/diffs`' worker pool — deliberate, not a shortcut:
 * that pool is a module-scope singleton (`getOrCreateWorkerPoolSingleton`),
 * not per-provider, so a second `WorkerPoolContextProvider` mounted here
 * would silently lose to whichever one the real diff pane
 * (`diff-code-view.tsx`) already mounted, and its own `highlighterOptions`
 * would never take effect. Fine for a 4-line snippet either way.
 */
import type { FileDiffOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import { MoonIcon, SunIcon } from "lucide-react";
import { useMemo } from "react";
import {
	DIFF_THEME_DARK_OPTIONS,
	DIFF_THEME_LIGHT_OPTIONS,
} from "#/components/diff-pane/diff-view-theme";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";

/**
 * A small, representative unified diff — a function whose body changes from
 * string concatenation to a template literal — kept local to this file
 * rather than shared fixture data, since nothing outside this preview needs
 * it. `parsePatchFiles` (`@pierre/diffs`) requires a real `diff --git`/`---`/
 * `+++`/`@@` header, not just the three content lines.
 */
const SAMPLE_PATCH = `${[
	"diff --git a/example.ts b/example.ts",
	"index 0000000..0000000 100644",
	"--- a/example.ts",
	"+++ b/example.ts",
	"@@ -1,3 +1,3 @@",
	" function greet(name: string) {",
	'-\treturn "Hello, " + name;',
	// biome-ignore lint/suspicious/noTemplateCurlyInString: literal sample source text, not an interpolation bug.
	"+\treturn `Hello, ${name}!`;",
	" }",
].join("\n")}\n`;

/**
 * `theme` is the currently-selected theme id for `pin`'s side (the light
 * `Select`'s value when `pin === "light"`, the dark `Select`'s value
 * otherwise) — this component doesn't read `@repo/settings` itself, it
 * renders whatever the caller's `Select` currently shows, so a change
 * repaints immediately without a round trip through persisted state.
 */
export function DiffThemePreview({
	theme,
	pin,
}: {
	theme: string;
	pin: "light" | "dark";
}): React.ReactElement {
	const options = useMemo<FileDiffOptions<undefined>>(
		() => ({
			theme: { light: theme, dark: theme },
			themeType: pin,
			disableFileHeader: true,
			disableVirtualizationBuffers: true,
		}),
		[theme, pin],
	);

	return (
		<div className="overflow-hidden rounded-lg border">
			<PatchDiff disableWorkerPool options={options} patch={SAMPLE_PATCH} />
		</div>
	);
}

/** Everything about a `DiffThemeColumn` that's derivable from `pin` alone. */
const DIFF_THEME_COLUMN_CONFIG = {
	light: {
		icon: SunIcon,
		options: DIFF_THEME_LIGHT_OPTIONS,
		ariaLabel: "Light diff theme",
	},
	dark: {
		icon: MoonIcon,
		options: DIFF_THEME_DARK_OPTIONS,
		ariaLabel: "Dark diff theme",
	},
} as const;

/**
 * One side (light or dark) of the Diff theme row in Settings > Appearance —
 * icon, options list, and aria-label are all derived from `pin`, since the
 * two sides only ever change together. Renders the icon + `Select` for
 * `pin`'s theme, plus that side's `DiffThemePreview` underneath.
 */
export function DiffThemeColumn({
	pin,
	value,
	onValueChange,
}: {
	pin: "light" | "dark";
	value: string;
	onValueChange: (value: string) => void;
}): React.ReactElement {
	const config = DIFF_THEME_COLUMN_CONFIG[pin];
	const Icon = config.icon;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-1.5">
				<Icon className="size-3.5 text-muted-foreground" />
				<Select
					items={config.options.map((option) => ({
						value: option.id,
						label: option.label,
					}))}
					onValueChange={(nextValue: string | null) => {
						if (nextValue !== null) onValueChange(nextValue);
					}}
					value={value}
				>
					<SelectTrigger
						aria-label={config.ariaLabel}
						className="w-full"
						size="sm"
					>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{config.options.map((option) => (
							<SelectItem key={option.id} value={option.id}>
								{option.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<DiffThemePreview pin={pin} theme={value} />
		</div>
	);
}
