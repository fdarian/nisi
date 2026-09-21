"use client";

/**
 * Owns every piece of ⌘-hover/⌘-click state for LSP code navigation, shared
 * verbatim by the diff pane (`diff-pane.tsx`, additions side only) and the
 * whole-file viewer (`file-view.tsx`) — both wire the same `codeViewOptions`
 * fragment into their own `CodeView` options and read `peekTarget`/`closePeek`
 * to decide whether to render a `CodeIndexPeekDialog` alongside the code view.
 * Nothing here renders anything itself; it only produces state and callbacks.
 *
 * `enabled` (from `useSessionCodeIndexEnabled`, defaults off every session —
 * see `session-ui-store.tsx`) is a real gate, not just a flag that skips the
 * callbacks: when it's false, this hook requests no file's occurrences,
 * attaches no keydown/keyup listeners, and
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
import type { CodeIndexOccurrence } from "@repo/sidecar-api";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	buildOccurrenceIndex,
	findOccurrenceForToken,
	type OccurrenceIndex,
} from "#/features/code-index/navigation/occurrence-index";
import type { SidecarQueryUtils } from "#/lib/backend-context";

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
 * One resolved ⌘-click, everything `CodeIndexPeekDialog` needs to render
 * without re-deriving it from the DOM event that opened it.
 *
 * The occurrence is resolved from the file's lazy response before a ⌘-click
 * opens the peek, so the dialog always has the symbol key needed for its
 * references request.
 */
export type CodeIndexPeekTarget = {
	/** The file the clicked token lives in. */
	path: string;
	occurrence: CodeIndexOccurrence;
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
	codeViewRef: React.RefObject<CodeViewHandle<Metadata, undefined> | null>;
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
		CodeViewOptions<Metadata, undefined>,
		"onTokenEnter" | "onTokenLeave" | "onTokenClick" | "useTokenTransformer"
	>;
	/** Appended to `unsafeCSS`/`extraCSS` — see `CODE_INDEX_TOKEN_CSS`. Empty while `enabled` is false. */
	tokenCSS: string;
	/** Call from the pane's own `onPostRender` for every non-`"unmount"` phase — lazily requests that item's occurrences once it's actually rendered, never per token. No-op while `enabled` is false. */
	notifyItemRendered: (path: string) => void;
	peekTarget: CodeIndexPeekTarget | null;
	closePeek: () => void;
	/**
	 * Whether the consumer's own `<DiffCodeView highlighterOptions>` choice
	 * (`diffHighlighterOptions` vs. `diffHighlighterOptionsWithTokenInteractions`,
	 * `diff-view-theme.ts`) should pay the per-token `data-char` wrapping cost.
	 */
	tokenInteractionsActive: boolean;
} {
	const queryClient = useQueryClient();
	const active = enabled;

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
	const retryFailedOccurrences = useCallback(
		(path: string) => {
			const queryOptions = orpc.codeIndex.fileOccurrences.queryOptions({
				input: { sessionId, path },
			});
			const state = queryClient.getQueryState(queryOptions.queryKey);
			if (state?.status !== "error") return;
			void queryClient.refetchQueries({
				queryKey: queryOptions.queryKey,
				exact: true,
			});
		},
		[orpc, queryClient, sessionId],
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
		queries: requestedPathList.map((path) => ({
			...orpc.codeIndex.fileOccurrences.queryOptions({
				input: { sessionId, path },
			}),
			retry: false,
		})),
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
			retryFailedOccurrences(path);
			rawHoverRef.current = {
				element: props.tokenElement,
				path,
				lineNumber: props.lineNumber,
				charStart: props.lineCharStart,
				charEnd: props.lineCharEnd,
			};
			recomputeHoveredOccurrence();
		},
		[
			active,
			notifyItemRendered,
			recomputeHoveredOccurrence,
			resolvePath,
			retryFailedOccurrences,
		],
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
			if (occurrence === undefined) return;
			event.preventDefault();
			setPeekTarget({
				path,
				occurrence,
			});
		},
		[active, resolvePath, occurrenceIndexByPath],
	);

	const codeViewOptions = useMemo(():
		| Pick<
				CodeViewOptions<Metadata, undefined>,
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
			CodeViewOptions<Metadata, undefined>,
			"onTokenEnter" | "onTokenLeave" | "onTokenClick" | "useTokenTransformer"
		>;
	}, [active, handleTokenEnter, handleTokenLeave, handleTokenClick]);

	return {
		codeViewOptions,
		tokenCSS: active ? CODE_INDEX_TOKEN_CSS : "",
		notifyItemRendered,
		peekTarget,
		closePeek,
		tokenInteractionsActive: active,
	};
}
