"use client";

/**
 * The worker-pool-provisioned `CodeView` instance itself — the one piece
 * that's genuinely identical between the Files Changed diff pane
 * (`diff-pane.tsx`) and the walkthrough reference-block pane
 * (`#/components/walkthrough/reference-pane.tsx`): both feed `@pierre/diffs`
 * items through the same worker pool sizing, the same highlighter, and the
 * same theme/layout constants (`diff-view-theme.ts`). What genuinely differs
 * per pane — `items`, annotations, custom headers, `diffStyle`,
 * `onPostRender` — stays a prop, not folded in here.
 */
import type {
	CodeViewItem,
	CodeViewOptions,
	DiffLineAnnotation,
	LineAnnotation,
} from "@pierre/diffs";
import {
	CodeView,
	type CodeViewHandle,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useMemo } from "react";
import {
	DIFF_VIEW_THEME,
	diffCodeViewLayout,
	diffHighlighterOptions,
	diffItemMetrics,
	diffViewUnsafeCSS,
} from "#/components/diff-pane/diff-view-theme";
import type { DiffStyleMode } from "#/lib/settings-data";

function useDiffWorkerPoolOptions() {
	return useMemo(
		() => ({
			poolSize: Math.min(3, Math.max(1, navigator.hardwareConcurrency || 3)),
			workerFactory: () =>
				new Worker(new URL("@pierre/diffs/worker/worker.js", import.meta.url), {
					type: "module",
				}),
		}),
		[],
	);
}

/** The theme/layout/metrics knobs every `CodeView` instance in the app shares — `diffStyle` and `onPostRender` are the two that vary per pane. */
export function buildDiffCodeViewOptions<Metadata>(overrides: {
	diffStyle?: DiffStyleMode;
	onPostRender?: CodeViewOptions<Metadata>["onPostRender"];
}): CodeViewOptions<Metadata> {
	return {
		diffIndicators: "bars",
		diffStyle: overrides.diffStyle ?? "unified",
		enableGutterUtility: false,
		hunkSeparators: "line-info-basic",
		itemMetrics: diffItemMetrics,
		layout: diffCodeViewLayout,
		onPostRender: overrides.onPostRender,
		stickyHeaders: true,
		theme: DIFF_VIEW_THEME,
		themeType: "system",
		tokenizeMaxLength: 100_000,
		unsafeCSS: diffViewUnsafeCSS,
	};
}

type DiffCodeViewProps<Metadata> = {
	className: string;
	items: readonly CodeViewItem<Metadata>[];
	options: CodeViewOptions<Metadata>;
	renderAnnotation: (
		annotation: LineAnnotation<Metadata> | DiffLineAnnotation<Metadata>,
	) => React.ReactNode;
	renderCustomHeader?: (item: CodeViewItem<Metadata>) => React.ReactNode;
	ref?: React.Ref<CodeViewHandle<Metadata>>;
};

export function DiffCodeView<Metadata>({
	className,
	items,
	options,
	renderAnnotation,
	renderCustomHeader,
	ref,
}: DiffCodeViewProps<Metadata>): React.ReactElement {
	const workerPoolOptions = useDiffWorkerPoolOptions();

	return (
		<WorkerPoolContextProvider
			highlighterOptions={diffHighlighterOptions}
			poolOptions={workerPoolOptions}
		>
			<CodeView
				className={className}
				items={items}
				options={options}
				ref={ref}
				renderAnnotation={renderAnnotation}
				renderCustomHeader={renderCustomHeader}
			/>
		</WorkerPoolContextProvider>
	);
}
