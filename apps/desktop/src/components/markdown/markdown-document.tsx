"use client";

import type { ThemesType } from "@pierre/diffs";
import { openUrl } from "@tauri-apps/plugin-opener";
import type * as React from "react";
import { useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, {
	defaultSchema,
	type Options as RehypeSanitizeOptions,
} from "rehype-sanitize";
import rehypeSlug from "rehype-slug";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { MarkdownCodeBlock } from "#/components/markdown/markdown-code-block";

type MarkdownDocumentProps = {
	source: string;
	theme: ThemesType;
};

const markdownSanitizeSchema: RehypeSanitizeOptions = {
	...defaultSchema,
	tagNames: Array.from(
		new Set([
			...(defaultSchema.tagNames ?? []),
			"details",
			"picture",
			"source",
			"summary",
		]),
	),
	attributes: {
		...defaultSchema.attributes,
		"*": [
			...(defaultSchema.attributes?.["*"] ?? []),
			"align",
			"height",
			"width",
		],
		details: [...(defaultSchema.attributes?.details ?? []), "open"],
		div: [...(defaultSchema.attributes?.div ?? []), "align", "height", "width"],
		img: [
			...(defaultSchema.attributes?.img ?? []),
			"align",
			"height",
			"sizes",
			"srcSet",
			"width",
		],
		h1: [...(defaultSchema.attributes?.h1 ?? []), "id"],
		h2: [...(defaultSchema.attributes?.h2 ?? []), "id"],
		h3: [...(defaultSchema.attributes?.h3 ?? []), "id"],
		h4: [...(defaultSchema.attributes?.h4 ?? []), "id"],
		h5: [...(defaultSchema.attributes?.h5 ?? []), "id"],
		h6: [...(defaultSchema.attributes?.h6 ?? []), "id"],
		p: [...(defaultSchema.attributes?.p ?? []), "align", "height", "width"],
		picture: [...(defaultSchema.attributes?.picture ?? []), "align"],
		source: [
			...(defaultSchema.attributes?.source ?? []),
			"height",
			"media",
			"sizes",
			"src",
			"srcSet",
			"type",
			"width",
		],
		summary: [...(defaultSchema.attributes?.summary ?? []), "align"],
	},
};

const externalUrlPattern = /^(?:https?:|mailto:|tel:)/i;

function withoutNode<T extends object>(props: T): Omit<T, "node"> {
	const cleanProps = { ...props } as T & { node?: unknown };
	Reflect.deleteProperty(cleanProps, "node");
	return cleanProps as Omit<T, "node">;
}

function MarkdownLink(props: React.ComponentProps<"a">): React.ReactElement {
	const href = typeof props.href === "string" ? props.href : undefined;
	const isFragment = href?.startsWith("#") === true;
	const isExternal = href !== undefined && externalUrlPattern.test(href);
	const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
		if (href === undefined || isFragment) return;
		event.preventDefault();
		if (isExternal) void openUrl(href);
	};

	return (
		<a
			{...withoutNode(props)}
			className="font-medium text-foreground underline decoration-border underline-offset-4 transition-colors hover:decoration-foreground"
			href={href}
			onClick={handleClick}
			rel={isExternal ? "noreferrer" : undefined}
		/>
	);
}

function MarkdownImage(props: React.ComponentProps<"img">): React.ReactElement {
	const [failed, setFailed] = useState(false);

	if (failed) {
		const label =
			props.alt === undefined
				? "Image unavailable"
				: `Image unavailable: ${props.alt}`;
		return (
			<span
				aria-label={label}
				className="my-4 inline-flex max-w-full items-center rounded-lg border border-dashed border-border bg-muted/40 px-3 py-2 text-muted-foreground text-sm"
				role="img"
			>
				{label}
			</span>
		);
	}

	return (
		<img
			{...withoutNode(props)}
			alt={props.alt === undefined ? "" : props.alt}
			className="my-4 max-w-full rounded-lg border border-border/70 shadow-sm"
			loading="lazy"
			onError={() => setFailed(true)}
		/>
	);
}

function MarkdownTable(
	props: React.ComponentProps<"table">,
): React.ReactElement {
	return (
		<div className="my-6 max-w-full overflow-x-auto rounded-lg border border-border/70">
			<table
				{...withoutNode(props)}
				className="m-0 min-w-full border-collapse text-left text-sm"
			/>
		</div>
	);
}

function MarkdownInlineCode(
	props: React.ComponentProps<"code">,
): React.ReactElement {
	const isFencedCode =
		typeof props.className === "string" &&
		props.className.split(/\s+/).some((name) => name.startsWith("language-"));
	return (
		<code
			{...withoutNode(props)}
			className={
				isFencedCode
					? props.className
					: "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-code-foreground before:content-none after:content-none"
			}
		/>
	);
}

export function MarkdownDocument(
	props: MarkdownDocumentProps,
): React.ReactElement {
	const components = useMemo<Components>(
		() => ({
			a: MarkdownLink,
			blockquote: (elementProps) => (
				<blockquote
					{...withoutNode(elementProps)}
					className="border-border bg-muted/30 text-muted-foreground"
				/>
			),
			code: MarkdownInlineCode,
			details: (elementProps) => (
				<details
					{...withoutNode(elementProps)}
					className="my-4 rounded-lg border border-border/70 bg-muted/20 px-4 py-3"
				/>
			),
			h1: (elementProps) => (
				<h1
					{...withoutNode(elementProps)}
					className="scroll-mt-8 font-heading text-3xl font-semibold tracking-tight"
				/>
			),
			h2: (elementProps) => (
				<h2
					{...withoutNode(elementProps)}
					className="scroll-mt-8 border-border/70 border-b pb-2 font-heading text-2xl font-semibold tracking-tight"
				/>
			),
			h3: (elementProps) => (
				<h3
					{...withoutNode(elementProps)}
					className="scroll-mt-8 font-heading text-xl font-semibold tracking-tight"
				/>
			),
			h4: (elementProps) => (
				<h4
					{...withoutNode(elementProps)}
					className="scroll-mt-8 font-heading text-lg font-semibold"
				/>
			),
			h5: (elementProps) => (
				<h5
					{...withoutNode(elementProps)}
					className="scroll-mt-8 font-heading text-base font-semibold"
				/>
			),
			h6: (elementProps) => (
				<h6
					{...withoutNode(elementProps)}
					className="scroll-mt-8 font-heading text-sm font-semibold uppercase tracking-wide"
				/>
			),
			img: MarkdownImage,
			input: (elementProps) => (
				<input
					{...withoutNode(elementProps)}
					className="me-2 size-4 align-[-0.125em] accent-primary disabled:opacity-100"
					disabled
					readOnly
					type="checkbox"
				/>
			),
			li: (elementProps) => (
				<li {...withoutNode(elementProps)} className="leading-7" />
			),
			ol: (elementProps) => (
				<ol {...withoutNode(elementProps)} className="my-4 space-y-1 pl-6" />
			),
			p: (elementProps) => (
				<p
					{...withoutNode(elementProps)}
					className="leading-7 text-foreground"
				/>
			),
			pre: (elementProps) => (
				<MarkdownCodeBlock theme={props.theme}>
					{elementProps.children}
				</MarkdownCodeBlock>
			),
			hr: (elementProps) => (
				<hr {...withoutNode(elementProps)} className="border-border/70" />
			),
			summary: (elementProps) => (
				<summary
					{...withoutNode(elementProps)}
					className="cursor-pointer font-medium text-foreground marker:text-muted-foreground"
				/>
			),
			table: MarkdownTable,
			td: (elementProps) => (
				<td
					{...withoutNode(elementProps)}
					className="border-border/70 border-b px-3 py-2 align-top"
				/>
			),
			th: (elementProps) => (
				<th
					{...withoutNode(elementProps)}
					className="border-border/70 border-b bg-muted/40 px-3 py-2 text-left font-semibold text-foreground"
				/>
			),
			tr: (elementProps) => (
				<tr {...withoutNode(elementProps)} className="last:border-b-0" />
			),
			ul: (elementProps) => (
				<ul {...withoutNode(elementProps)} className="my-4 space-y-1 pl-6" />
			),
		}),
		[props.theme],
	);

	return (
		<div className="markdown-document min-h-0 flex-1 overflow-auto overscroll-contain px-6 py-10 sm:px-10">
			<article className="prose dark:prose-invert mx-auto w-full max-w-[72ch] pb-16 text-base">
				<ReactMarkdown
					components={components}
					rehypePlugins={[
						rehypeRaw,
						[rehypeSanitize, markdownSanitizeSchema],
						rehypeSlug,
					]}
					remarkPlugins={[remarkGfm, remarkFrontmatter]}
				>
					{props.source}
				</ReactMarkdown>
			</article>
		</div>
	);
}
