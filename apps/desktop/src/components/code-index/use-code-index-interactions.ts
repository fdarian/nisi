"use client";

/**
 * Owns every piece of ⌘-hover/⌘-click state for SCIP code navigation, shared
 * verbatim by the diff pane (`diff-pane.tsx`, additions side only) and the
 * whole-file viewer (`file-view.tsx`) — both wire the same `codeViewOptions`
 * fragment into their own `CodeView` options and read `peekTarget`/`closePeek`
 * to decide whether (and where) to render a `CodeIndexPeekPanel` annotation.
 * Nothing here renders anything itself; it only produces state and callbacks.
 *
 * `enabled` (from `useSessionCodeIndexEnabled`, defaults off every session —
 * see `session-ui-store.tsx`) is a real gate, not just a flag that skips the
 * callbacks: when it's false, this hook makes no `codeIndex.status` request,
 * requests no file's occurrences, attaches no keydown/keyup listeners, and
 * its returned `codeViewOptions` is `{}` — spreading in nothing, so the
 * consumer's own `CodeView` never even learns these callbacks exist. The one
 * piece a caller must *also* gate itself is `useTokenTransformer` at the
 * `WorkerPoolContextProvider` level (`diff-view-theme.ts`'s
 * `diffHighlighterOptions` vs. `diffHighlighterOptionsWithTokenInteractions`,
 * chosen via `DiffCodeView`'s `highlighterOptions` prop) — that's what
 * actually avoids the per-token `data-char` wrapping cost, and it can't be
 * expressed as a per-item `CodeViewOptions` field alone (see that constant's
 * own doc comment for why).
 */
import type {
	CodeViewOptions,
	DiffTokenEventBaseProps,
	TokenEventBase,
} from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";
import type { CodeIndexOccurrence, CodeIndexStatus } from "@repo/sidecar-api";
import { useQueries } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildOccurrenceIndex,
	findOccurrenceForToken,
	type OccurrenceIndex,
} from "#/components/code-index/occurrence-index";
import { useCodeIndexStatus } from "#/components/code-index/use-code-index-status";
import type { SidecarQueryUtils } from "#/lib/backend-context";

/**
 * Statuses `handleTokenClick` (below) treats as "the index exists in some
 * form, or could — a ⌘-click should still surface the peek so its
 * build/rebuild affordance is reachable" — mirrors `code-index-peek-panel.tsx`'s
 * `IndexStatusBanner`, which already renders a distinct affordance for each.
 * `unsupported` is deliberately excluded — the feature stays invisible there
 * by design (no tsconfig means nothing here could ever resolve); `ready`
 * is excluded too, since a `ready` index that still failed to match a token
 * means the click genuinely wasn't on an indexed symbol.
 */
const INDEX_NOT_READY_STATUSES: ReadonlySet<CodeIndexStatus["status"]> =
	new Set(["absent", "stale", "building", "failed"]);

/** Class toggled directly on a token's `HTMLElement` — `@pierre/diffs` has no keyed decoration API, so this is the supported way to style one token (see `InteractionManager`'s own doc). Styled via `extraCSS`/`unsafeCSS` in each pane's `CodeViewOptions` — see `CODE_INDEX_TOKEN_CSS` below. */
export const CODE_INDEX_TOKEN_ACTIVE_CLASS = "nisi-code-index-token-active";

/** Appended to each pane's `unsafeCSS` (`buildDiffCodeViewOptions`'s `extraCSS`) so the class above actually renders inside `@pierre/diffs`' shadow root. */
export const CODE_INDEX_TOKEN_CSS = `
	.${CODE_INDEX_TOKEN_ACTIVE_CLASS} {
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 3px;
		cursor: pointer;
	}
`;

/**
 * One resolved ⌘-click, everything `CodeIndexPeekPanel` needs to render
 * without re-deriving it from the DOM event that opened it. `charStart`/
 * `charEnd` are the clicked token's own range (0-based, SCIP's coordinate
 * space — see `occurrence-index.ts`) — carried alongside `occurrence` rather
 * than only inside it, since they're what the panel falls back to anchoring
 * its source preview on when `occurrence` is `undefined`.
 *
 * `occurrence` is optional, not defaulted to a placeholder: a ⌘-click while
 * the index is `absent`/`stale`/`building`/`failed` still opens the peek
 * (`handleTokenClick`, below) so its build/rebuild affordance is reachable,
 * but there's genuinely no occurrence to report in that case — inventing one
 * would be a lie the panel would have to un-tell.
 */
export type CodeIndexPeekTarget = {
	/** The file the clicked token lives in — the peek annotation anchors here. */
	path: string;
	/** 1-based — `@pierre/diffs`' own line-numbering, already converted from SCIP's 0-based `occurrence.line`. */
	lineNumber: number;
	charStart: number;
	charEnd: number;
	occurrence: CodeIndexOccurrence | undefined;
};

/**
 * The one annotation variant this feature contributes. `file-view.tsx` uses
 * it directly as its item's whole `Metadata` type (it has no other
 * annotation kind); `diff-pane.tsx` folds it into its own
 * `DiffAnnotationMetadata` union alongside its five existing variants.
 */
export type CodeIndexPeekAnnotationMetadata = {
	type: "code-index-peek";
	target: CodeIndexPeekTarget;
};

function setTokenActive(element: HTMLElement, active: boolean): void {
	element.classList.toggle(CODE_INDEX_TOKEN_ACTIVE_CLASS, active);
}

/**
 * Which rendered item (`diff-pane.tsx`/`file-view.tsx` both key items by file
 * path, so the item id *is* the path) a token event's target belongs to.
 * `@pierre/diffs` renders each item into its own shadow root, so a plain
 * `element.contains(tokenElement)` walk can't be trusted to cross that
 * boundary — `event.composedPath()` does, the same technique
 * `diff-code-view.tsx`'s `forwardDeadSpaceSeparatorClick` already relies on
 * for a different event.
 */
function resolvePathFromEvent(
	event: { composedPath(): EventTarget[] },
	renderedItems: readonly { id: string; element: HTMLElement }[],
): string | undefined {
	const idByElement = new Map(
		renderedItems.map((item) => [item.element, item.id] as const),
	);
	for (const node of event.composedPath()) {
		if (!(node instanceof HTMLElement)) continue;
		const id = idByElement.get(node);
		if (id !== undefined) return id;
	}
	return undefined;
}

type TokenProps = TokenEventBase | DiffTokenEventBaseProps;

/** `DiffTokenEventBaseProps.side` only exists on the diff-mode overload — `TokenEventBase` (file mode) carries no side at all, which is exactly "not deletions". */
function isDeletionsSideToken(props: TokenProps): boolean {
	return "side" in props && props.side === "deletions";
}

/** A fragment with none of this feature's callbacks/options set — what `codeViewOptions` resolves to while `enabled` is false, so spreading it into the pane's own options changes nothing at all. */
const DISABLED_CODE_VIEW_OPTIONS = {};

type UseCodeIndexInteractionsOptions<Metadata> = {
	sessionId: string;
	orpc: SidecarQueryUtils;
	/** The `CodeView` this hook drives — read only for `getInstance().getRenderedItems()`, to resolve which file a token event belongs to. */
	codeViewRef: React.RefObject<CodeViewHandle<Metadata> | null>;
	/** From `useSessionCodeIndexEnabled` — the whole feature's real on/off switch. See this module's own doc comment for exactly what turns off. */
	enabled: boolean;
};

export function useCodeIndexInteractions<Metadata>({
	sessionId,
	orpc,
	codeViewRef,
	enabled,
}: UseCodeIndexInteractionsOptions<Metadata>): {
	/** Spread into the pane's own `CodeViewOptions` — `{}` while `enabled` is false. */
	codeViewOptions: Pick<
		CodeViewOptions<Metadata>,
		"onTokenEnter" | "onTokenLeave" | "onTokenClick" | "useTokenTransformer"
	>;
	/** Appended to `unsafeCSS`/`extraCSS` — see `CODE_INDEX_TOKEN_CSS`. Empty while `enabled` is false. */
	tokenCSS: string;
	/** Call from the pane's own `onPostRender` for every non-`"unmount"` phase — lazily requests that item's occurrences once it's actually rendered, never per token. No-op while `enabled` is false. */
	notifyItemRendered: (path: string) => void;
	peekTarget: CodeIndexPeekTarget | null;
	closePeek: () => void;
	/**
	 * `codeIndex.status` — exposed here too (rather than only inside
	 * `CodeIndexPeekPanel`) since `handleTokenClick`'s fallback-open below
	 * already needs it. `undefined` while `enabled` is false (the query
	 * itself is disabled — see this module's own doc comment).
	 */
	indexStatus: CodeIndexStatus | undefined;
	buildIndex: () => void;
	isBuildStarting: boolean;
	/**
	 * `enabled` narrowed by "and not a known-`unsupported` repo" — what the
	 * consumer's own `<DiffCodeView highlighterOptions>` choice
	 * (`diffHighlighterOptions` vs. `diffHighlighterOptionsWithTokenInteractions`,
	 * `diff-view-theme.ts`) should actually key off, since paying the
	 * per-token `data-char` wrapping cost for a repo this feature could never
	 * work in would be exactly the waste the toggle exists to avoid.
	 */
	tokenInteractionsActive: boolean;
} {
	const indexStatusQuery = useCodeIndexStatus(orpc, sessionId, enabled);
	// The toggle being on isn't the whole story once status resolves: an
	// `unsupported` repo (no tsconfig) has nothing this feature could ever
	// index, so every `fileOccurrences` request would just come back empty —
	// harmless, but exactly the waste the toggle exists to avoid. `active`
	// self-corrects the moment that's known, without needing the toggle
	// itself flipped back off (`files-changed-view.tsx` does that
	// separately, once, so the checkbox stays hidden from then on). Stays
	// `true` until the status query actually resolves — a brief window right
	// after enabling where a few `fileOccurrences` requests could still fire
	// for an unsupported repo before this narrows; self-limiting, not worth
	// blocking on.
	const active = enabled && indexStatusQuery.status?.status !== "unsupported";

	// Paths whose occurrences have been requested — grows via
	// `notifyItemRendered` (called from each pane's own `onPostRender`), so a
	// file only ever costs one `fileOccurrences` round trip, made once it's
	// actually rendered rather than for every file in a possibly-huge diff.
	// Never grows while `enabled` is false (`notifyItemRendered` no-ops), so
	// `requestedPathList` — and therefore `queries` below — stays empty and
	// no `fileOccurrences` request ever fires.
	const [requestedPaths, setRequestedPaths] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const notifyItemRendered = useCallback(
		(path: string) => {
			if (!active) return;
			setRequestedPaths((current) =>
				current.has(path) ? current : new Set(current).add(path),
			);
		},
		[active],
	);

	const requestedPathList = useMemo(
		() => Array.from(requestedPaths),
		[requestedPaths],
	);
	// `combine` (not a bare `.map(q => q.data)` over `useQueries`' own result)
	// for the same reason `pr-data.ts`'s `useFileContents` needs it: plain
	// `useQueries` with no `combine` hands back a fresh array every render
	// regardless of whether any query's data actually changed, which would
	// otherwise give `occurrenceIndexByPath` a new identity every render and
	// cascade into every callback derived from it below (`handleTokenClick`,
	// `recomputeHoveredOccurrence`, ...), right up to `codeViewOptions` —
	// forcing `CodeView` to re-bind its interaction callbacks on every
	// unrelated render of the pane. `combine` must itself stay referentially
	// stable across renders where `requestedPathList` hasn't changed, hence
	// the `useCallback`.
	const combineOccurrenceIndexByPath = useCallback(
		(
			results: readonly { data: readonly CodeIndexOccurrence[] | undefined }[],
		): ReadonlyMap<string, OccurrenceIndex> => {
			const map = new Map<string, OccurrenceIndex>();
			requestedPathList.forEach((path, index) => {
				const data = results[index]?.data;
				if (data !== undefined) map.set(path, buildOccurrenceIndex(data));
			});
			return map;
		},
		[requestedPathList],
	);
	const occurrenceIndexByPath = useQueries({
		combine: combineOccurrenceIndexByPath,
		queries: requestedPathList.map((path) =>
			orpc.codeIndex.fileOccurrences.queryOptions({
				input: { sessionId, path },
			}),
		),
	});

	// The token currently under the pointer, regardless of whether it matched
	// an occurrence yet — kept separate from `hoveredTokenRef` (below) so a
	// `fileOccurrences` response landing *after* `onTokenEnter` already fired
	// (found nothing, since the index wasn't loaded yet) can still recompute
	// and light the token up once the data arrives, without needing another
	// pointer move. See the `occurrenceIndexByPath` effect below.
	const rawHoverRef = useRef<{
		element: HTMLElement;
		path: string;
		lineNumber: number;
		charStart: number;
		charEnd: number;
	} | null>(null);
	// The subset of the above that actually matched an occurrence — what
	// drives the underline class and what `onTokenClick` reads from.
	const hoveredTokenRef = useRef<{
		element: HTMLElement;
		path: string;
		lineNumber: number;
		occurrence: CodeIndexOccurrence;
	} | null>(null);
	const metaHeldRef = useRef(false);

	const recomputeHoveredOccurrence = useCallback(() => {
		const previous = hoveredTokenRef.current;
		const raw = rawHoverRef.current;
		const occurrenceIndex =
			raw === null ? undefined : occurrenceIndexByPath.get(raw.path);
		const occurrence =
			raw === null || occurrenceIndex === undefined
				? undefined
				: findOccurrenceForToken(
						occurrenceIndex,
						raw.lineNumber,
						raw.charStart,
						raw.charEnd,
					);
		const next =
			raw === null || occurrence === undefined
				? null
				: {
						element: raw.element,
						path: raw.path,
						lineNumber: raw.lineNumber,
						occurrence,
					};
		if (previous !== null && previous.element !== next?.element) {
			setTokenActive(previous.element, false);
		}
		hoveredTokenRef.current = next;
		if (next !== null) setTokenActive(next.element, metaHeldRef.current);
	}, [occurrenceIndexByPath]);

	// Re-resolves whatever's currently hovered whenever a file's occurrences
	// finish loading — closes the race between `onTokenEnter` firing before
	// `fileOccurrences` has resolved and the pointer still resting there once
	// it does.
	useEffect(() => {
		recomputeHoveredOccurrence();
	}, [recomputeHoveredOccurrence]);

	// The underline must react to ⌘ going up/down even when the pointer
	// hasn't moved since — so this listens globally rather than relying on
	// `onTokenEnter`/`onTokenLeave` alone. `blur` covers ⌘-Tab, which leaves
	// no `keyup` for the key that was held when focus left. Attaches nothing
	// at all while `enabled` is false — part of "off costs exactly what it
	// cost before this feature existed" (this module's own doc comment).
	useEffect(() => {
		if (!active) return;
		const applyMetaHeld = (held: boolean) => {
			metaHeldRef.current = held;
			const hovered = hoveredTokenRef.current;
			if (hovered !== null) setTokenActive(hovered.element, held);
		};
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Meta") applyMetaHeld(true);
		};
		const handleKeyUp = (event: KeyboardEvent) => {
			if (event.key === "Meta") applyMetaHeld(false);
		};
		const handleBlur = () => applyMetaHeld(false);
		window.addEventListener("keydown", handleKeyDown);
		window.addEventListener("keyup", handleKeyUp);
		window.addEventListener("blur", handleBlur);
		return () => {
			window.removeEventListener("keydown", handleKeyDown);
			window.removeEventListener("keyup", handleKeyUp);
			window.removeEventListener("blur", handleBlur);
		};
	}, [active]);

	const [peekTarget, setPeekTarget] = useState<CodeIndexPeekTarget | null>(
		null,
	);
	const closePeek = useCallback(() => setPeekTarget(null), []);
	// Escape dismisses the peek the same way it dismisses the diff-selection
	// popover elsewhere in this pane — the peek is an inline annotation, not a
	// Base UI popup, so it gets no Escape handling for free.
	useEffect(() => {
		if (peekTarget === null) return;
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") closePeek();
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [peekTarget, closePeek]);

	const resolvePath = useCallback(
		(event: { composedPath(): EventTarget[] }): string | undefined => {
			const viewer = codeViewRef.current?.getInstance();
			if (viewer === undefined) return undefined;
			return resolvePathFromEvent(event, viewer.getRenderedItems());
		},
		[codeViewRef],
	);

	const handleTokenEnter = useCallback(
		(props: TokenProps, event: PointerEvent) => {
			if (!active) return;
			if (isDeletionsSideToken(props)) return;
			const path = resolvePath(event);
			if (path === undefined) return;
			notifyItemRendered(path);
			rawHoverRef.current = {
				element: props.tokenElement,
				path,
				lineNumber: props.lineNumber,
				charStart: props.lineCharStart,
				charEnd: props.lineCharEnd,
			};
			recomputeHoveredOccurrence();
		},
		[active, resolvePath, notifyItemRendered, recomputeHoveredOccurrence],
	);

	const handleTokenLeave = useCallback((props: TokenProps) => {
		if (rawHoverRef.current?.element === props.tokenElement) {
			rawHoverRef.current = null;
		}
		if (hoveredTokenRef.current?.element === props.tokenElement) {
			setTokenActive(props.tokenElement, false);
			hoveredTokenRef.current = null;
		}
	}, []);

	const handleTokenClick = useCallback(
		(props: TokenProps, event: MouseEvent) => {
			if (!active) return;
			if (!event.metaKey) return;
			if (isDeletionsSideToken(props)) return;
			const path = resolvePath(event);
			if (path === undefined) return;
			const occurrenceIndex = occurrenceIndexByPath.get(path);
			const occurrence =
				occurrenceIndex === undefined
					? undefined
					: findOccurrenceForToken(
							occurrenceIndex,
							props.lineNumber,
							props.lineCharStart,
							props.lineCharEnd,
						);
			// No occurrence match doesn't necessarily mean "not a symbol" — it
			// can just as easily mean "no index to match against yet". Surface
			// the peek anyway when the index is in one of those recoverable
			// states, so its build/rebuild affordance is reachable from a ⌘-click
			// even before an index has ever been built.
			const indexNotReady =
				indexStatusQuery.status !== undefined &&
				INDEX_NOT_READY_STATUSES.has(indexStatusQuery.status.status);
			if (occurrence === undefined && !indexNotReady) return;
			event.preventDefault();
			setPeekTarget({
				path,
				lineNumber: props.lineNumber,
				charStart: props.lineCharStart,
				charEnd: props.lineCharEnd,
				occurrence,
			});
		},
		[active, resolvePath, occurrenceIndexByPath, indexStatusQuery.status],
	);

	const codeViewOptions = useMemo(():
		| Pick<
				CodeViewOptions<Metadata>,
				"onTokenEnter" | "onTokenLeave" | "onTokenClick" | "useTokenTransformer"
		  >
		| typeof DISABLED_CODE_VIEW_OPTIONS => {
		if (!active) return DISABLED_CODE_VIEW_OPTIONS;
		return {
			// `@pierre/diffs` only emits the per-token `data-char` attribute its
			// own `InteractionManager.resolvePointerTarget` hit-tests against
			// (`utils/wrapTokenFragments.js`) when `shouldUseTokenTransformer`
			// resolves true — which auto-detects from `onTokenClick`/
			// `onTokenEnter`/`onTokenLeave` being non-null (`utils/
			// shouldUseTokenTransformer.js`), EXCEPT that auto-detection runs
			// against whatever options reach the *tokenizing* pass, and
			// `WorkerPoolContextProvider` (`diff-code-view.tsx`) renders through
			// a Web Worker — functions aren't structured-cloneable, so the
			// worker never sees these callbacks to auto-detect from in the
			// first place. Confirmed live: without this, every rendered token
			// span carries no `data-char` at all (`sr.querySelectorAll('[data-char]')`
			// returns empty), so `resolvePointerTarget` never resolves a token
			// hit and `onTokenClick`/`onTokenEnter` silently never fire —
			// `useTokenTransformer: true` is the serializable flag that reaches
			// the worker instead.
			useTokenTransformer: true,
			// `onTokenEnter`/`onTokenLeave`/`onTokenClick` are declared with a
			// 2-arg `(props, event)` signature per `InteractionManagerBaseOptions`
			// (`InteractionManager.d.ts:47-53`) — the handlers above match that
			// shape directly; the cast below only reconciles it with
			// `CodeViewOptions`' dual file/diff-overloaded callback type, which
			// TypeScript can't collapse to our single union-typed implementation
			// on its own.
			onTokenEnter: handleTokenEnter,
			onTokenLeave: handleTokenLeave,
			onTokenClick: handleTokenClick,
		} as Pick<
			CodeViewOptions<Metadata>,
			"onTokenEnter" | "onTokenLeave" | "onTokenClick" | "useTokenTransformer"
		>;
	}, [active, handleTokenEnter, handleTokenLeave, handleTokenClick]);

	return {
		codeViewOptions,
		tokenCSS: active ? CODE_INDEX_TOKEN_CSS : "",
		notifyItemRendered,
		peekTarget,
		closePeek,
		indexStatus: indexStatusQuery.status,
		buildIndex: indexStatusQuery.build,
		isBuildStarting: indexStatusQuery.isBuildStarting,
		tokenInteractionsActive: active,
	};
}
