import { tool } from "ai";
import { Schema } from "effect";
import {
	applyEdit,
	describeEditFailure,
	type WalkthroughBuffer,
} from "./buffer.ts";

const WriteInput = Schema.Struct({
	content: Schema.String.annotate({
		description:
			"The complete walkthrough document, replacing any existing content. Must be valid JSON matching the walkthrough schema from the system prompt.",
	}),
});

const EditInput = Schema.Struct({
	oldString: Schema.String.check(Schema.isMinLength(1)).annotate({
		description:
			"The exact text to find in the walkthrough buffer, including whitespace. Must be unique unless replaceAll is set.",
	}),
	newString: Schema.String.annotate({
		description: "The text to replace it with.",
	}),
	replaceAll: Schema.optional(Schema.Boolean).annotate({
		description:
			"Replace every occurrence of oldString instead of requiring it to be uniquely identifying. Defaults to false.",
	}),
});

/**
 * The agent's output tools, bound to one buffer. Deliberately shaped like
 * Claude Code's own Write/Edit tools minus the file path — there's exactly
 * one walkthrough per turn, so there's nothing to path into, and the model
 * already knows these mechanics.
 */
export const createWalkthroughTools = (buffer: WalkthroughBuffer) => ({
	write: tool({
		description:
			"Write the complete walkthrough document, replacing any existing content. Prefer `edit` for small revisions once a draft exists.",
		inputSchema: Schema.toStandardSchemaV1(WriteInput),
		execute: async (input: Schema.Schema.Type<typeof WriteInput>) => {
			buffer.content = input.content;
			return "Wrote the walkthrough buffer.";
		},
	}),
	edit: tool({
		description:
			"Replace one exact string with another in the walkthrough buffer — the same semantics as your own file-editing tool, applied to this one document instead of a file. Use this for targeted revisions instead of rewriting the whole document with `write`.",
		inputSchema: Schema.toStandardSchemaV1(EditInput),
		execute: async (input: Schema.Schema.Type<typeof EditInput>) => {
			const outcome = applyEdit(
				buffer.content,
				input.oldString,
				input.newString,
				input.replaceAll ?? false,
			);
			if (!outcome.ok) {
				return describeEditFailure(outcome.failure);
			}
			buffer.content = outcome.content;
			return "Edited the walkthrough buffer.";
		},
	}),
});
