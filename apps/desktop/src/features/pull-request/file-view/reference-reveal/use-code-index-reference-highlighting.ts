"use client";

import type { CodeViewHandle } from "@pierre/diffs/react";
import { useCallback, useEffect, useId, useMemo, useRef } from "react";
import {
	type CodeIndexReferenceTarget,
	codeIndexDisplayedLine,
	codeIndexTargetLength,
} from "#/features/code-index/navigation/code-index-navigation";
import {
	buildMatchRange,
	findFileLineRowElement,
	SUPPORTS_HIGHLIGHT_API,
} from "#/features/diff/viewer/diff-match-dom";

function referenceHighlightCSS(name: string): string {
	// Matches the reference-row mark (`bg-primary/25`) and the ⌘-hover
	// underline, while the Custom Highlight range spans syntax-token nodes.
	return `
		::highlight(${name}) {
			background-color: color-mix(in srgb, var(--color-primary) 25%, transparent);
			text-decoration: underline;
			text-decoration-thickness: 2px;
			text-underline-offset: 3px;
		}
	`;
}

type UseCodeIndexReferenceHighlightingOptions<Metadata> = {
	codeViewRef: React.RefObject<CodeViewHandle<Metadata, undefined> | null>;
	target: CodeIndexReferenceTarget | undefined;
};

/**
 * Keeps one exact LSP character range highlighted in a CodeView item. It
 * reuses the same CSS Custom Highlight and row-addressing primitives as
 * keyword search, so syntax-token DOM can be replaced without losing the
 * range. The caller owns the target lifetime and clears it on user focus;
 * rendered-item notifications drive the virtualized-row retry.
 */
export function useCodeIndexReferenceHighlighting<Metadata>(
	props: UseCodeIndexReferenceHighlightingOptions<Metadata>,
): {
	highlightCSS: string;
	onItemPostRender: (
		path: string,
		shadowRoot: ShadowRoot | undefined,
	) => boolean;
	tryApplyTarget: (target: CodeIndexReferenceTarget) => boolean;
} {
	const codeViewRef = props.codeViewRef;
	const target = props.target;
	const instanceId = useId().replace(/[^a-zA-Z0-9]/g, "");
	const highlightName = useMemo(
		() => `nisi-code-index-reference-${instanceId}`,
		[instanceId],
	);
	const highlightCSS = useMemo(
		() => referenceHighlightCSS(highlightName),
		[highlightName],
	);
	const highlightRef = useRef<Highlight | undefined>(undefined);
	const targetRef = useRef<CodeIndexReferenceTarget | undefined>(target);

	useEffect(() => {
		targetRef.current = target;
	}, [target]);

	useEffect(() => {
		if (!SUPPORTS_HIGHLIGHT_API) return;
		const highlight = new Highlight();
		highlightRef.current = highlight;
		CSS.highlights.set(highlightName, highlight);
		return () => {
			CSS.highlights.delete(highlightName);
			highlightRef.current = undefined;
		};
	}, [highlightName]);

	const applyTarget = useCallback(
		(
			current: CodeIndexReferenceTarget,
			path: string,
			shadowRoot: ShadowRoot,
		): boolean => {
			const highlight = highlightRef.current;
			if (
				current === undefined ||
				current.path !== path ||
				highlight === undefined
			) {
				return false;
			}
			const row = findFileLineRowElement(
				shadowRoot,
				codeIndexDisplayedLine(current),
			);
			const length = codeIndexTargetLength(current);
			const range =
				row === undefined || length === undefined
					? undefined
					: buildMatchRange(row, current.charStart, length);
			if (range === undefined) return false;
			highlight.clear();
			highlight.add(range);
			return true;
		},
		[],
	);
	const tryApplyTarget = useCallback(
		(current: CodeIndexReferenceTarget): boolean => {
			const item = codeViewRef.current
				?.getInstance()
				?.getRenderedItems()
				.find((candidate) => candidate.id === current.path);
			if (item === undefined) return false;
			if (!SUPPORTS_HIGHLIGHT_API) return true;
			const shadowRoot = item.element.shadowRoot;
			return (
				shadowRoot !== null && applyTarget(current, current.path, shadowRoot)
			);
		},
		[applyTarget, codeViewRef],
	);

	const onItemPostRender = useCallback(
		(path: string, shadowRoot: ShadowRoot | undefined) => {
			const current = targetRef.current;
			if (current === undefined || current.path !== path) return false;
			if (shadowRoot === undefined) {
				highlightRef.current?.clear();
				return false;
			}
			if (!SUPPORTS_HIGHLIGHT_API) return true;
			return applyTarget(current, path, shadowRoot);
		},
		[applyTarget],
	);

	useEffect(() => {
		if (!SUPPORTS_HIGHLIGHT_API) return;
		if (target === undefined) {
			highlightRef.current?.clear();
			return;
		}
		tryApplyTarget(target);
	}, [target, tryApplyTarget]);

	return { highlightCSS, onItemPostRender, tryApplyTarget };
}
