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
import { useMemo } from "react";

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
