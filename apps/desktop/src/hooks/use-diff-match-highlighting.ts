"use client";

/**
 * Keyword-search match highlighting for one `DiffPane` instance — the
 * stateful half of the concern `#/lib/diff-match-dom.ts` provides pure
 * DOM primitives for. Owns the CSS Custom Highlight API registry lifecycle
 * (two `Highlight`s per instance, since `CSS.highlights` is one
 * document-global registry and more than one `DiffPane` can be mounted at
 * once — one per open PR tab), and hands the pane back exactly two things:
 * `highlightCSS` to fold into `codeViewOptions.extraCSS`, and
 * `onItemPostRender` to call from the pane's own `onPostRender`. Everything
 * else — the registry names, the two `Highlight` objects, tracking which
 * match is "current" — stays internal.
 */
import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import { diffSearchHighlightCSS } from "#/components/diff-pane/diff-view-theme";
import {
	buildMatchRange,
	findMatchRowElement,
	pollUntilReady,
	SUPPORTS_HIGHLIGHT_API,
} from "#/lib/diff-match-dom";
import type { DiffMatch } from "#/lib/diff-search";

type UseDiffMatchHighlightingOptions<LAnnotation> = {
	/** The same `CodeViewHandle` ref the pane hands to `<DiffCodeView>` — used only to look up an already-rendered item's shadow root when bootstrapping the "current match" highlight for a target that isn't mounted yet (see the effect below). */
	codeViewRef: React.RefObject<CodeViewHandle<LAnnotation, undefined> | null>;
	/** Keyed by path — the same shape `DiffPane` already threads through for narrowing (`keywordMatchesByPath`). */
	keywordMatchesByPath: ReadonlyMap<string, readonly DiffMatch[]>;
	/** The match `n`/`N`/Enter last parked on — highlighted distinctly via a higher-priority `::highlight()`. `undefined` means nothing is "current" (keyword mode off, or no navigation yet). */
	currentMatch: DiffMatch | undefined;
};

export function useDiffMatchHighlighting<LAnnotation>({
	codeViewRef,
	keywordMatchesByPath,
	currentMatch,
}: UseDiffMatchHighlightingOptions<LAnnotation>): {
	/** Appended to `codeViewOptions.extraCSS` — the `::highlight()` rules for this instance's own registry names. */
	highlightCSS: string;
	/** Call from the pane's own `onPostRender` for every item, every phase — `shadowRoot` present for `"mount"`/`"update"`, `undefined` for `"unmount"`. */
	onItemPostRender: (path: string, shadowRoot: ShadowRoot | undefined) => void;
} {
	// `CSS.highlights` is one document-global registry, and more than one
	// `DiffPane` can be mounted at once (one per open PR tab) — a fixed
	// highlight name would let a background tab's search overwrite the
	// active tab's highlights. `useId()` scopes each instance's pair of
	// names (stripped of everything but alphanumerics: `useId()` includes
	// `:`, which a CSS `<custom-ident>` for `::highlight()` can't contain).
	const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
	const highlightNames = useMemo(
		() => ({
			all: `nisi-search-match-${instanceId}`,
			current: `nisi-search-match-current-${instanceId}`,
		}),
		[instanceId],
	);
	const highlightCSS = useMemo(
		() => diffSearchHighlightCSS(highlightNames),
		[highlightNames],
	);

	// Per-path `Range`s for every match, keyed so an item's unmount/update can
	// retract exactly its own contribution before the shared `Highlight` is
	// rebuilt from what remains — see `onItemPostRender` below.
	const matchRangesByPath = useRef(new Map<string, Range[]>());
	const allMatchesHighlight = useRef<Highlight | undefined>(undefined);
	const currentMatchHighlight = useRef<Highlight | undefined>(undefined);
	const currentMatchFrame = useRef<number | null>(null);

	// Read inside `onItemPostRender` without making it depend on `currentMatch`
	// directly — the pane would otherwise have to rebuild its whole
	// `codeViewOptions` (and every item's `renderedOptionsRevision`) on every
	// `n`/`N` keypress, for a value only this one callback needs.
	const currentMatchRef = useRef<DiffMatch | undefined>(currentMatch);
	useEffect(() => {
		currentMatchRef.current = currentMatch;
	}, [currentMatch]);

	// Registers this instance's two `Highlight`s once, under its own names,
	// and unregisters them on unmount — `CSS.highlights` has no other
	// lifecycle hook, so a `DiffPane` that unmounts without this would leak
	// its highlights (and its now-meaningless instance-scoped name) into the
	// registry forever.
	useEffect(() => {
		if (!SUPPORTS_HIGHLIGHT_API) return;
		const all = new Highlight();
		const current = new Highlight();
		current.priority = 1;
		allMatchesHighlight.current = all;
		currentMatchHighlight.current = current;
		CSS.highlights.set(highlightNames.all, all);
		CSS.highlights.set(highlightNames.current, current);
		return () => {
			CSS.highlights.delete(highlightNames.all);
			CSS.highlights.delete(highlightNames.current);
		};
	}, [highlightNames]);

	// Rebuilds the current-match `Highlight` from `match`'s own row inside
	// `shadowRoot` — `true` once it actually finds something to highlight.
	// Shared by `onItemPostRender` (every relevant item render) and the
	// poll-until-mounted effect below (a match whose file isn't rendered yet).
	const applyCurrentMatchHighlight = useCallback(
		(match: DiffMatch, shadowRoot: ShadowRoot): boolean => {
			const highlight = currentMatchHighlight.current;
			if (highlight === undefined) return false;
			const row = findMatchRowElement(shadowRoot, match.side, match.rowLine);
			const range = row && buildMatchRange(row, match.offset, match.length);
			if (range === undefined) return false;
			highlight.clear();
			highlight.add(range);
			return true;
		},
		[],
	);

	// Recomputes one item's match highlighting from its rendered shadow root
	// — the pane calls this from its own `onPostRender` on every mount/update
	// (`shadowRoot` present) and unmount (`shadowRoot` undefined). Two
	// things, not one: the "all matches" contribution (folded into the
	// shared `Highlight` alongside every other rendered item's), and — when
	// this item happens to be the current match's own file — the "current
	// match" highlight too. The second part matters because `@pierre/diffs`
	// re-renders a row asynchronously once its worker-pool syntax
	// highlighting finishes, which replaces the very text nodes an earlier
	// `Range` pointed into (silently collapsing it, confirmed live) —
	// relying solely on the `currentMatch`-keyed effect below to build that
	// `Range` once would leave the highlight broken the moment tokenizing
	// catches up.
	const onItemPostRender = useCallback(
		(path: string, shadowRoot: ShadowRoot | undefined) => {
			if (!SUPPORTS_HIGHLIGHT_API) return;
			const matches = keywordMatchesByPath.get(path);
			if (
				shadowRoot === undefined ||
				matches === undefined ||
				matches.length === 0
			) {
				matchRangesByPath.current.delete(path);
			} else {
				const ranges: Range[] = [];
				for (const match of matches) {
					const row = findMatchRowElement(
						shadowRoot,
						match.side,
						match.rowLine,
					);
					const range = row && buildMatchRange(row, match.offset, match.length);
					if (range !== undefined) ranges.push(range);
				}
				if (ranges.length > 0) matchRangesByPath.current.set(path, ranges);
				else matchRangesByPath.current.delete(path);
			}
			const highlight = allMatchesHighlight.current;
			if (highlight !== undefined) {
				highlight.clear();
				for (const ranges of matchRangesByPath.current.values()) {
					for (const range of ranges) highlight.add(range);
				}
			}

			const current = currentMatchRef.current;
			if (current !== undefined && current.path === path) {
				if (shadowRoot === undefined) currentMatchHighlight.current?.clear();
				else applyCurrentMatchHighlight(current, shadowRoot);
			}
		},
		[keywordMatchesByPath, applyCurrentMatchHighlight],
	);

	// Bootstraps the "current match" highlight for a target whose file isn't
	// mounted yet — once it *is* mounted, `onItemPostRender` (above) takes
	// over keeping it fresh, including through the async re-render described
	// above. Only needs to run when `currentMatch` itself changes — explicit
	// navigation (the pane's own `scrollToMatch` also runs, independently)
	// or a query edit quietly resetting to the first match without any
	// scroll at all — and retries across frames since the target item (and
	// this specific row within it) may not be mounted yet.
	useEffect(() => {
		if (!SUPPORTS_HIGHLIGHT_API) return;
		if (currentMatch === undefined) {
			currentMatchHighlight.current?.clear();
			return;
		}
		const match = currentMatch;
		pollUntilReady(() => {
			const items = codeViewRef.current?.getInstance()?.getRenderedItems();
			const shadowRoot = items?.find((item) => item.id === match.path)?.element
				.shadowRoot;
			return (
				shadowRoot != null && applyCurrentMatchHighlight(match, shadowRoot)
			);
		}, currentMatchFrame);
	}, [currentMatch, applyCurrentMatchHighlight, codeViewRef]);

	useEffect(
		() => () => {
			if (currentMatchFrame.current !== null) {
				cancelAnimationFrame(currentMatchFrame.current);
			}
		},
		[],
	);

	return { highlightCSS, onItemPostRender };
}
