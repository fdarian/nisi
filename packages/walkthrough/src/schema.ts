import { Schema } from "effect";

/**
 * 1-based inclusive line range in a file's **head** (current) content — the
 * same numbering the diff renderer shows the reviewer, so a location can be
 * handed straight to it with no re-derivation.
 */
export const Location = Schema.Struct({
	path: Schema.String.annotate({
		description:
			"The changed file's path, relative to the repo root, exactly as it appears in the diff digest.",
	}),
	startLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
		description:
			"1-based inclusive start line, in the file's current (head) content.",
	}),
	endLine: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
		description:
			"1-based inclusive end line, in the file's current (head) content. May equal startLine for a single line.",
	}),
});
export type Location = Schema.Schema.Type<typeof Location>;

/**
 * A named set of locations, possibly spanning multiple files. Section
 * bodies link to these via `[text](ref:<id>)` instead of repeating file
 * content inline — a claim spanning three files points at three ranges
 * instead of dumping three files on the reader.
 */
export const ReferenceBlock = Schema.Struct({
	id: Schema.String.check(Schema.isMinLength(1)).annotate({
		description:
			"A short, unique identifier for this block, referenced from section bodies as [text](ref:<id>).",
	}),
	label: Schema.String.check(Schema.isMinLength(1)).annotate({
		description:
			'A short human-readable label shown next to the block\'s locations, e.g. "Session token refresh".',
	}),
	locations: Schema.Array(Location).check(Schema.isMinLength(1)).annotate({
		description:
			"The set of line ranges this block claims. Can span multiple files — a claim spanning three files should list three locations here instead of being split into three blocks.",
	}),
});
export type ReferenceBlock = Schema.Schema.Type<typeof ReferenceBlock>;

/** One narrative section. `body` is markdown; `[text](ref:<id>)` links resolve against `Walkthrough.references`. */
export const Section = Schema.Struct({
	title: Schema.String.check(Schema.isMinLength(1)).annotate({
		description: "The section's heading.",
	}),
	body: Schema.String.annotate({
		description:
			"Markdown prose narrating this part of the change. Every factual claim about the code must link to the reference block backing it, using [text](ref:<id>) — id must match a block in `references`.",
	}),
});
export type Section = Schema.Schema.Type<typeof Section>;

export const Walkthrough = Schema.Struct({
	version: Schema.Literal(1),
	sections: Schema.Array(Section).check(Schema.isMinLength(1)).annotate({
		description: "The walkthrough's narrative, in reading order.",
	}),
	references: Schema.Array(ReferenceBlock).annotate({
		description:
			"Every reference block linked from `sections`, plus any block needed to cover the remaining changed lines. Every changed line in every changed file must be claimed by at least one location here.",
	}),
});
export type Walkthrough = Schema.Schema.Type<typeof Walkthrough>;

/**
 * The walkthrough schema as a JSON Schema document (draft 2020-12),
 * generated via Effect's built-in helper rather than hand-written — the
 * only way the system prompt's schema and `Walkthrough` can't drift apart.
 */
export const walkthroughJsonSchemaDocument =
	Schema.toJsonSchemaDocument(Walkthrough);

/** `walkthroughJsonSchemaDocument` flattened into one self-contained object (`$defs` inlined) — what `buildSystemPrompt` embeds. */
export const walkthroughJsonSchema: Record<string, unknown> =
	Object.keys(walkthroughJsonSchemaDocument.definitions).length === 0
		? walkthroughJsonSchemaDocument.schema
		: {
				...walkthroughJsonSchemaDocument.schema,
				$defs: walkthroughJsonSchemaDocument.definitions,
			};
