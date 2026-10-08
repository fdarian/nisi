import {
	defaultSchema,
	type Options as RehypeSanitizeOptions,
} from "rehype-sanitize";

/** Shared by every markdown renderer that lets raw HTML through (`MarkdownDocument`, `ProseMarkdown`). */
export const markdownSanitizeSchema: RehypeSanitizeOptions = {
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
