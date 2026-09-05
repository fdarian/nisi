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
	CodeView as CodeViewInstance,
	CodeViewItem,
	CodeViewLineSelection,
	CodeViewOptions,
	DiffLineAnnotation,
	LineAnnotation,
} from "@pierre/diffs";
import {
	CodeView,
	type CodeViewHandle,
	WorkerPoolContextProvider,
} from "@pierre/diffs/react";
import { useCallback, useMemo, useRef } from "react";
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

/**
 * @pierre/diffs only resolves a hunk-separator click when the hit lands directly on
 * `[data-expand-button]` or `[data-unmodified-lines]` (its own
 * `InteractionManager.resolvePointerTarget`, `managers/InteractionManager.js`) — both small
 * islands inside the full-width band `diffViewUnsafeCSS` paints as
 * `[data-separator-wrapper]`. Everywhere else in that band — most of its area, confirmed live by
 * measuring the rendered rects — a click silently does nothing, on both the deletions and the
 * additions side, even though the band is styled to look like one uniform clickable strip.
 *
 * This forwards such a "dead space" click to the band's own expand control, found via
 * `.closest`/`.querySelector` within the *same* `[data-separator]` subtree the click landed in —
 * never a different one, so it can't expand the wrong hunk the way correlating separators across
 * the deletions/additions columns by ordinal position could. Forwarding is a synthetic
 * `HTMLElement.click()` on that real control, not a reimplementation of the expand behavior
 * itself: the resulting click re-enters this same handler (it bubbles through the shadow root the
 * same as any other click), but its target now carries `data-expand-button`/`data-unmodified-lines`
 * directly, so the early return below stops it before it forwards again.
 */
function forwardDeadSpaceSeparatorClick(event: MouseEvent): void {
	let wrapper: HTMLElement | undefined;
	for (const node of event.composedPath()) {
		if (!(node instanceof HTMLElement)) continue;
		if (
			node.hasAttribute("data-expand-button") ||
			node.hasAttribute("data-unmodified-lines")
		) {
			// @pierre/diffs already resolved this click to a real expand control.
			return;
		}
		if (wrapper == null && node.hasAttribute("data-separator-wrapper")) {
			wrapper = node;
		}
	}
	if (wrapper == null) return; // Click wasn't inside a hunk-separator band at all.

	const separator = wrapper.closest('[data-separator="line-info-basic"]');
	if (separator == null) {
		throw new Error(
			"diff-code-view: [data-separator-wrapper] rendered outside its [data-separator] parent",
		);
	}

	const expandTarget =
		separator.querySelector<HTMLElement>(
			"[data-expand-button]:not([data-expand-all-button])",
		) ?? separator.querySelector<HTMLElement>("[data-unmodified-lines]");
	if (expandTarget == null) {
		throw new Error(
			"diff-code-view: hunk-separator band has no expand control to forward a click to",
		);
	}
	expandTarget.click();
}

/**
 * Wires `forwardDeadSpaceSeparatorClick` onto `CodeView`'s own container div via its
 * `containerRef` prop. That prop is invoked imperatively by @pierre/diffs (`react/CodeView.js`'s
 * `nodeRef`), not attached as a plain React `ref`, so a returned cleanup function wouldn't be
 * called automatically the way React 19's native ref-cleanup would — the previous node is tracked
 * and detached by hand instead, mirroring the teardown-leak lesson in
 * `knowledge/codeview-teardown-leak-patch.md`: nothing here should stay subscribed past the node
 * it was attached to.
 */
function useSeparatorClickForwarding() {
	const attachedNodeRef = useRef<HTMLDivElement | null>(null);
	return useCallback((node: HTMLDivElement | null) => {
		if (attachedNodeRef.current != null) {
			attachedNodeRef.current.removeEventListener(
				"click",
				forwardDeadSpaceSeparatorClick,
			);
			attachedNodeRef.current = null;
		}
		if (node != null) {
			node.addEventListener("click", forwardDeadSpaceSeparatorClick);
			attachedNodeRef.current = node;
		}
	}, []);
}

/** The theme/layout/metrics knobs every `CodeView` instance in the app shares — `diffStyle`, `overflow`, `onPostRender` and `extraCSS` are what vary per pane. */
export function buildDiffCodeViewOptions<Metadata>(overrides: {
	diffStyle?: DiffStyleMode;
	/**
	 * `'wrap'` wraps long lines instead of letting them scroll horizontally —
	 * a top-level `CodeViewOptions` key (`CODE_VIEW_DIFF_OPTION_KEYS`), so
	 * `CodeView` re-applies it to already-mounted items via its own options
	 * revision when this changes, no remount needed. Defaults to `'scroll'`,
	 * `@pierre/diffs`' own default.
	 */
	overflow?: CodeViewOptions<Metadata, undefined>["overflow"];
	onPostRender?: CodeViewOptions<Metadata, undefined>["onPostRender"];
	/** Appended to `diffViewUnsafeCSS` inside each item's shadow root — for styling only one pane's items, e.g. `diffCardChromeCSS`. */
	extraCSS?: string;
	/**
	 * Turns on `@pierre/diffs`' own line-lane (gutter) drag-to-select — off by
	 * default so a pane opts in explicitly. `ReferencePane` doesn't set this:
	 * enabling selection with no `selectedLines`/`onSelectedLinesChange` (and
	 * no floating "Copy reference" button reacting to it) would let a user
	 * paint a highlight that never does anything.
	 */
	enableLineSelection?: boolean;
}): CodeViewOptions<Metadata, undefined> {
	return {
		diffIndicators: "bars",
		diffStyle: overrides.diffStyle ?? "unified",
		enableGutterUtility: false,
		enableLineSelection: overrides.enableLineSelection ?? false,
		hunkSeparators: "line-info-basic",
		itemMetrics: diffItemMetrics,
		layout: diffCodeViewLayout,
		onPostRender: overrides.onPostRender,
		overflow: overrides.overflow ?? "scroll",
		stickyHeaders: true,
		theme: DIFF_VIEW_THEME,
		themeType: "system",
		tokenizeMaxLength: 100_000,
		unsafeCSS: `${diffViewUnsafeCSS}${overrides.extraCSS ?? ""}`,
	};
}

type DiffCodeViewProps<Metadata> = {
	className: string;
	items: readonly CodeViewItem<Metadata>[];
	options: CodeViewOptions<Metadata, undefined>;
	/** Forwarded straight to `CodeView`'s own `onScroll` — fires for both user-driven and programmatic scrolling; telling the two apart is the caller's job (see `DiffPane`'s scroll-report suppression). */
	onScroll?: (scrollTop: number, viewer: CodeViewInstance<Metadata>) => void;
	renderAnnotation: (
		annotation: LineAnnotation<Metadata> | DiffLineAnnotation<Metadata>,
	) => React.ReactNode;
	renderCustomHeader?: (item: CodeViewItem<Metadata>) => React.ReactNode;
	/**
	 * The line-lane (gutter) selection to render, and its change callback —
	 * both forwarded straight to `CodeView`. Passing either turns `CodeView`
	 * into controlled-selection mode, so a caller that wants
	 * `enableLineSelection` (`buildDiffCodeViewOptions`) must supply both;
	 * `ReferencePane` supplies neither and stays uncontrolled/off.
	 */
	selectedLines?: CodeViewLineSelection | null;
	onSelectedLinesChange?: (selection: CodeViewLineSelection | null) => void;
	ref?: React.Ref<CodeViewHandle<Metadata, undefined>>;
};

export function DiffCodeView<Metadata>({
	className,
	items,
	onScroll,
	onSelectedLinesChange,
	options,
	renderAnnotation,
	renderCustomHeader,
	selectedLines,
	ref,
}: DiffCodeViewProps<Metadata>): React.ReactElement {
	const workerPoolOptions = useDiffWorkerPoolOptions();
	const separatorClickForwardingRef = useSeparatorClickForwarding();

	return (
		<WorkerPoolContextProvider
			highlighterOptions={diffHighlighterOptions}
			poolOptions={workerPoolOptions}
		>
			<CodeView
				className={className}
				containerRef={separatorClickForwardingRef}
				items={items}
				onScroll={onScroll}
				onSelectedLinesChange={onSelectedLinesChange}
				options={options}
				ref={ref}
				renderAnnotation={renderAnnotation}
				renderCustomHeader={renderCustomHeader}
				selectedLines={selectedLines}
			/>
		</WorkerPoolContextProvider>
	);
}
