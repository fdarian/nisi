"use client";

import type { SupportedLanguages, ThemesType } from "@pierre/diffs";
import { getSharedHighlighter } from "@pierre/diffs";
import * as React from "react";
import { useEffect, useState } from "react";

type MarkdownCodeBlockProps = {
	children?: React.ReactNode;
	theme: ThemesType;
};

type CodeElementProps = {
	children?: React.ReactNode;
	className?: string;
};

type HighlightState =
	| { key: string; status: "pending" }
	| { html: string; key: string; status: "ready" }
	| { key: string; status: "error" };

const codeBlockClassName =
	"markdown-code-block my-6 max-w-full overflow-x-auto rounded-xl border border-border/70 bg-code p-4 font-mono text-[0.8125rem] leading-relaxed text-code-foreground shadow-sm";

function findCodeElement(
	children: React.ReactNode,
): React.ReactElement<CodeElementProps> | undefined {
	const firstChild = React.Children.toArray(children)[0];
	return React.isValidElement<CodeElementProps>(firstChild)
		? firstChild
		: undefined;
}

function codeText(children: React.ReactNode): string {
	return React.Children.toArray(children)
		.map((child) => {
			if (typeof child === "string" || typeof child === "number") {
				return String(child);
			}
			if (React.isValidElement<{ children?: React.ReactNode }>(child)) {
				return codeText(child.props.children);
			}
			return "";
		})
		.join("");
}

function withoutTrailingLineBreak(value: string): string {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function languageFromClassName(
	className: string | undefined,
): SupportedLanguages {
	const languageClass = className
		?.split(/\s+/)
		.find((name) => name.startsWith("language-"));
	if (languageClass === undefined) return "text";

	const language = languageClass.slice("language-".length);
	return language.length > 0 ? language : "text";
}

export function MarkdownCodeBlock(
	props: MarkdownCodeBlockProps,
): React.ReactElement {
	const codeElement = findCodeElement(props.children);
	const source = withoutTrailingLineBreak(
		codeText(codeElement?.props.children ?? props.children),
	);
	const language = languageFromClassName(codeElement?.props.className);
	const lightTheme = props.theme.light;
	const darkTheme = props.theme.dark;
	const highlightKey = [language, lightTheme, darkTheme, source].join("\u0000");
	const [highlightState, setHighlightState] = useState<HighlightState>({
		key: highlightKey,
		status: "pending",
	});

	useEffect(() => {
		const cancellation = { cancelled: false };
		setHighlightState({ key: highlightKey, status: "pending" });

		const highlight = async (): Promise<void> => {
			try {
				const highlighter = await getSharedHighlighter({
					langs: [language],
					themes: [lightTheme, darkTheme],
				});
				const html = highlighter.codeToHtml(source, {
					defaultColor: false,
					lang: language,
					tabindex: false,
					themes: { dark: darkTheme, light: lightTheme },
				});

				if (!cancellation.cancelled) {
					setHighlightState({ html, key: highlightKey, status: "ready" });
				}
			} catch {
				if (!cancellation.cancelled) {
					setHighlightState({ key: highlightKey, status: "error" });
				}
			}
		};

		void highlight();
		return () => {
			cancellation.cancelled = true;
		};
	}, [darkTheme, highlightKey, language, lightTheme, source]);

	if (
		highlightState.status === "ready" &&
		highlightState.key === highlightKey
	) {
		const highlightedBlock = React.createElement("div", {
			className: codeBlockClassName,
			// biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki escapes the source text before producing this markup.
			dangerouslySetInnerHTML: { __html: highlightState.html },
		});
		return highlightedBlock;
	}

	return (
		<pre className={codeBlockClassName}>
			<code>{source}</code>
		</pre>
	);
}
