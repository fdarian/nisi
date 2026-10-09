"use client";

/**
 * Markdown for the compact `text-sm` cards on the Overview and Walkthrough
 * tabs (PR description, walkthrough narrative). The long-form file viewer
 * (`file-view/markdown/markdown-document.tsx`) has its own, larger-scale map;
 * the plugin setup and sanitize schema are shared with it.
 */
import { cn } from "cn";
import { useMemo } from "react";
import ReactMarkdown, {
	type Components,
	defaultUrlTransform,
} from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { markdownSanitizeSchema } from "#/features/pull-request/file-view/markdown/markdown-sanitize-schema";

function withoutNode<T extends object>(props: T): Omit<T, "node"> {
	const cleanProps = { ...props } as T & { node?: unknown };
	Reflect.deleteProperty(cleanProps, "node");
	return cleanProps as Omit<T, "node">;
}

export function ProseLink(
	props: React.ComponentProps<"a">,
): React.ReactElement {
	return (
		<a
			{...withoutNode(props)}
			className="underline underline-offset-2"
			rel="noreferrer"
			target="_blank"
		/>
	);
}

/** Headings are told apart by weight, size and spacing only — the cards are `text-sm`, so there's no room for a document-scale type ramp. */
export const proseComponents: Components = {
	a: ProseLink,
	blockquote: (props) => (
		<blockquote
			{...withoutNode(props)}
			className="border-l-2 pl-3 text-muted-foreground"
		/>
	),
	code: (props) => (
		<code
			{...withoutNode(props)}
			className={cn(
				"rounded bg-muted px-1 py-0.5 font-mono text-[0.8125em]",
				props.className,
			)}
		/>
	),
	del: (props) => (
		<del {...withoutNode(props)} className="text-muted-foreground" />
	),
	details: (props) => (
		<details
			{...withoutNode(props)}
			className="rounded-md border bg-muted/20 px-3 py-2 [&[open]>summary]:mb-2"
		/>
	),
	h1: (props) => (
		<h1
			{...withoutNode(props)}
			className="mt-2 border-b pb-1 font-heading font-semibold text-lg first:mt-0"
		/>
	),
	h2: (props) => (
		<h2
			{...withoutNode(props)}
			className="mt-2 border-b pb-1 font-heading font-semibold text-base first:mt-0"
		/>
	),
	h3: (props) => (
		<h3
			{...withoutNode(props)}
			className="mt-1 font-heading font-semibold text-base first:mt-0"
		/>
	),
	h4: (props) => (
		<h4
			{...withoutNode(props)}
			className="mt-1 font-heading font-semibold text-sm first:mt-0"
		/>
	),
	h5: (props) => (
		<h5
			{...withoutNode(props)}
			className="font-heading font-semibold text-sm first:mt-0"
		/>
	),
	h6: (props) => (
		<h6
			{...withoutNode(props)}
			className="font-heading font-semibold text-muted-foreground text-xs uppercase tracking-wide first:mt-0"
		/>
	),
	hr: (props) => <hr {...withoutNode(props)} className="border-border" />,
	img: (props) => (
		<img
			{...withoutNode(props)}
			alt={props.alt === undefined ? "" : props.alt}
			className="max-w-full rounded-md"
			loading="lazy"
		/>
	),
	input: (props) => (
		<input
			{...withoutNode(props)}
			className="me-1.5 size-3.5 align-[-0.125em] accent-primary disabled:opacity-100"
			disabled
			readOnly
			type="checkbox"
		/>
	),
	li: (props) => (
		<li
			{...withoutNode(props)}
			className={cn("[&>ol]:mt-1 [&>ul]:mt-1", props.className)}
		/>
	),
	ol: (props) => (
		<ol
			{...withoutNode(props)}
			className="list-decimal space-y-1 pl-5 [&_ol]:list-[lower-alpha]"
		/>
	),
	p: (props) => <p {...withoutNode(props)} className="text-foreground" />,
	pre: (props) => (
		<pre
			{...withoutNode(props)}
			className="overflow-x-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em]"
		/>
	),
	strong: (props) => (
		<strong {...withoutNode(props)} className="font-semibold text-foreground" />
	),
	summary: (props) => (
		<summary
			{...withoutNode(props)}
			className="cursor-pointer font-medium text-foreground marker:text-muted-foreground"
		/>
	),
	table: (props) => (
		<div className="max-w-full overflow-x-auto rounded-md border">
			<table
				{...withoutNode(props)}
				className="min-w-full border-collapse text-left text-sm [&_tbody_tr:last-child_td]:border-b-0"
			/>
		</div>
	),
	td: (props) => (
		<td {...withoutNode(props)} className="border-b px-3 py-1.5 align-top" />
	),
	th: (props) => (
		<th
			{...withoutNode(props)}
			className="border-b bg-muted/40 px-3 py-1.5 text-left font-semibold text-foreground"
		/>
	),
	ul: (props) => (
		<ul
			{...withoutNode(props)}
			className={cn(
				"list-disc space-y-1 pl-5 [&_ul]:list-[circle]",
				"[&.contains-task-list]:list-none [&.contains-task-list]:pl-0",
				props.className,
			)}
		/>
	),
};

type ProseMarkdownProps = {
	children: string;
	/** Merged over the shared map — a key here replaces the shared renderer for that tag. */
	components?: Components;
	/** URL schemes allowed through in addition to the sanitizer's defaults, e.g. the walkthrough's `ref:` links. */
	extraHrefProtocols?: readonly string[];
};

export function ProseMarkdown(props: ProseMarkdownProps): React.ReactElement {
	const extraHrefProtocols = props.extraHrefProtocols;

	const sanitizeSchema = useMemo(() => {
		if (extraHrefProtocols === undefined) return markdownSanitizeSchema;
		return {
			...markdownSanitizeSchema,
			protocols: {
				...markdownSanitizeSchema.protocols,
				href: [
					...(markdownSanitizeSchema.protocols?.href ?? []),
					...extraHrefProtocols,
				],
			},
		};
	}, [extraHrefProtocols]);

	const components = useMemo<Components>(
		() => ({ ...proseComponents, ...props.components }),
		[props.components],
	);

	// react-markdown's default `urlTransform` blanks any scheme it doesn't know,
	// so a custom scheme like `ref:<id>` would become `href=""` (a self-link
	// that reloads the whole app) before the sanitizer ever sees it.
	const urlTransform = useMemo(() => {
		if (extraHrefProtocols === undefined) return defaultUrlTransform;
		return (url: string) =>
			extraHrefProtocols.some((protocol) => url.startsWith(`${protocol}:`))
				? url
				: defaultUrlTransform(url);
	}, [extraHrefProtocols]);

	return (
		<ReactMarkdown
			components={components}
			rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
			remarkPlugins={[remarkGfm]}
			urlTransform={urlTransform}
		>
			{props.children}
		</ReactMarkdown>
	);
}
