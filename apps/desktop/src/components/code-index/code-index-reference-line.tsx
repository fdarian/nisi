"use client";

import type { DiffsHighlighter, ThemedToken } from "@pierre/diffs";
import { getFiletypeFromFileName, getSharedHighlighter } from "@pierre/diffs";
import type { CodeIndexReference } from "@repo/sidecar-api";
import type { CSSProperties, ReactElement, ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DiffTheme } from "#/lib/diff/diff-view-theme";

type CodeIndexReferenceLineProps = {
	diffTheme: DiffTheme;
	path: string;
	reference: CodeIndexReference;
};

type ReferenceLineHighlightState =
	| { key: string; status: "pending" }
	| { key: string; status: "ready"; tokens: readonly ThemedToken[] }
	| { key: string; status: "error" };

const MAX_REFERENCE_LINE_TOKEN_CACHE_SIZE = 512;
const referenceLineTokenCache = new Map<string, readonly ThemedToken[]>();
const referenceLineTokenPromises = new Map<
	string,
	Promise<readonly ThemedToken[]>
>();
const referenceLineHighlighterPromises = new Map<
	string,
	Promise<DiffsHighlighter>
>();

function rememberReferenceLineTokens(
	key: string,
	tokens: readonly ThemedToken[],
): void {
	referenceLineTokenCache.delete(key);
	referenceLineTokenCache.set(key, tokens);
	if (referenceLineTokenCache.size <= MAX_REFERENCE_LINE_TOKEN_CACHE_SIZE) {
		return;
	}

	const oldestKey = referenceLineTokenCache.keys().next().value;
	if (oldestKey !== undefined) referenceLineTokenCache.delete(oldestKey);
}

function getReferenceLineHighlighter(
	language: ReturnType<typeof getFiletypeFromFileName>,
	theme: DiffTheme["theme"],
): Promise<DiffsHighlighter> {
	const key = [language, theme.light, theme.dark].join("\u0000");
	const existing = referenceLineHighlighterPromises.get(key);
	if (existing !== undefined) return existing;

	const promise = getSharedHighlighter({
		langs: [language],
		themes: [theme.light, theme.dark],
	}).finally(() => {
		referenceLineHighlighterPromises.delete(key);
	});
	referenceLineHighlighterPromises.set(key, promise);
	return promise;
}

function tokenizeReferenceLine(
	key: string,
	source: string,
	language: ReturnType<typeof getFiletypeFromFileName>,
	theme: DiffTheme["theme"],
): Promise<readonly ThemedToken[]> {
	const cached = referenceLineTokenCache.get(key);
	if (cached !== undefined) return Promise.resolve(cached);

	const existing = referenceLineTokenPromises.get(key);
	if (existing !== undefined) return existing;

	const promise = getReferenceLineHighlighter(language, theme)
		.then((highlighter) => {
			const tokens = highlighter.codeToTokens(source, {
				defaultColor: false,
				lang: language,
				themes: { dark: theme.dark, light: theme.light },
			}).tokens[0];
			if (tokens === undefined) {
				throw new Error(
					"code-index-reference-line: highlighter returned no line",
				);
			}
			rememberReferenceLineTokens(key, tokens);
			return tokens;
		})
		.finally(() => {
			referenceLineTokenPromises.delete(key);
		});
	referenceLineTokenPromises.set(key, promise);
	return promise;
}

function tokenStyle(token: ThemedToken): CSSProperties {
	if (token.htmlStyle !== undefined) {
		return token.htmlStyle as CSSProperties;
	}
	return {
		backgroundColor: token.bgColor,
		color: token.color,
	};
}

function HighlightedReferenceTokens(props: {
	tokens: readonly ThemedToken[];
	occurrence: { end: number; start: number } | undefined;
}): ReactElement {
	return (
		<>
			{props.tokens.map((token) => {
				const tokenStart = token.offset;
				const tokenEnd = token.offset + token.content.length;
				const overlapStart =
					props.occurrence === undefined
						? tokenStart
						: Math.max(tokenStart, props.occurrence.start);
				const overlapEnd =
					props.occurrence === undefined
						? tokenStart
						: Math.min(tokenEnd, props.occurrence.end);
				const hasOccurrence = overlapStart < overlapEnd;

				return (
					<span
						className="code-index-reference-token"
						key={token.offset}
						style={tokenStyle(token)}
					>
						{hasOccurrence ? (
							<>
								{token.content.slice(0, overlapStart - tokenStart)}
								<mark className="rounded-[3px] bg-primary/25 text-inherit">
									{token.content.slice(
										overlapStart - tokenStart,
										overlapEnd - tokenStart,
									)}
								</mark>
								{token.content.slice(overlapEnd - tokenStart)}
							</>
						) : (
							token.content
						)}
					</span>
				);
			})}
		</>
	);
}

function CodeIndexReferenceLineComponent(
	props: CodeIndexReferenceLineProps,
): ReactElement {
	const rawLine = props.reference.lineText;
	const displayLine = rawLine === null ? undefined : rawLine.trim();
	const language = useMemo(
		() => getFiletypeFromFileName(props.path),
		[props.path],
	);
	const highlightKey =
		displayLine === undefined
			? "unavailable"
			: [
					language,
					props.diffTheme.theme.light,
					props.diffTheme.theme.dark,
					displayLine,
				].join("\u0000");
	const cachedTokens =
		displayLine === undefined
			? undefined
			: referenceLineTokenCache.get(highlightKey);
	const [highlightState, setHighlightState] =
		useState<ReferenceLineHighlightState>(() =>
			cachedTokens === undefined
				? { key: highlightKey, status: "pending" }
				: { key: highlightKey, status: "ready", tokens: cachedTokens },
		);
	const [isVisible, setIsVisible] = useState(false);
	const lineRef = useRef<HTMLSpanElement>(null);

	useEffect(() => {
		const node = lineRef.current;
		if (node === null) return;
		if (typeof IntersectionObserver === "undefined") {
			setIsVisible(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					setIsVisible(true);
					observer.disconnect();
					return;
				}
			},
			{ rootMargin: "128px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		if (!isVisible || displayLine === undefined) return;
		if (cachedTokens !== undefined) {
			setHighlightState({
				key: highlightKey,
				status: "ready",
				tokens: cachedTokens,
			});
			return;
		}

		let cancelled = false;
		setHighlightState({ key: highlightKey, status: "pending" });
		void tokenizeReferenceLine(
			highlightKey,
			displayLine,
			language,
			props.diffTheme.theme,
		)
			.then((tokens) => {
				if (!cancelled) {
					setHighlightState({
						key: highlightKey,
						status: "ready",
						tokens,
					});
				}
			})
			.catch(() => {
				if (!cancelled) {
					setHighlightState({ key: highlightKey, status: "error" });
				}
			});
		return () => {
			cancelled = true;
		};
	}, [
		cachedTokens,
		displayLine,
		highlightKey,
		isVisible,
		language,
		props.diffTheme.theme,
	]);

	const occurrence = useMemo(() => {
		if (rawLine === null || displayLine === undefined) return undefined;
		const leadingTrimmed = rawLine.length - rawLine.trimStart().length;
		const start = Math.max(0, props.reference.charStart - leadingTrimmed);
		const end = Math.min(
			displayLine.length,
			props.reference.charEnd - leadingTrimmed,
		);
		return start < end ? { end, start } : undefined;
	}, [
		displayLine,
		props.reference.charEnd,
		props.reference.charStart,
		rawLine,
	]);

	const content: ReactNode =
		rawLine === null ? (
			<span className="italic">
				preview unavailable — couldn't read this file
			</span>
		) : highlightState.status === "ready" &&
			highlightState.key === highlightKey ? (
			<HighlightedReferenceTokens
				occurrence={occurrence}
				tokens={highlightState.tokens}
			/>
		) : (
			displayLine
		);

	return (
		<span
			className="code-index-reference-line min-w-0 truncate whitespace-pre font-mono text-[0.6875rem]"
			ref={lineRef}
		>
			{content}
		</span>
	);
}

export const CodeIndexReferenceLine = memo(CodeIndexReferenceLineComponent);
