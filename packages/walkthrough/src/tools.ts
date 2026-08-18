import type { JSONSchema7 } from "@ai-sdk/provider";
import { jsonSchema, tool } from "ai";
import { Result, Schema } from "effect";
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
 * Bridges an Effect `Schema` to the AI SDK's own `Schema` wrapper (a real
 * JSON Schema document plus a validate function) instead of going through
 * `Schema.toStandardSchemaV1` alone. AI SDK's `asSchema()` only derives a
 * JSON Schema from a bare Standard Schema V1 for the `zod` vendor; every
 * other vendor (Effect's included) needs the schema's own optional
 * `~standard.jsonSchema` extension, which Effect doesn't implement. Bridge
 * adapters that must advertise a tool's shape to an external process over
 * MCP (Claude Code, OpenCode) fell back to an empty schema without this —
 * confirmed live: the model called `write` with no arguments at all,
 * because it never saw `content` was a thing to pass. Codex's adapter
 * doesn't hit this path (no external MCP registration), which is why it
 * worked with the bare standard schema alone.
 */
const toToolInputSchema = <S extends Schema.ConstraintDecoder<unknown>>(
	effectSchema: S,
) => {
	const document = Schema.toJsonSchemaDocument(effectSchema);
	const flattened: JSONSchema7 = (
		Object.keys(document.definitions).length === 0
			? document.schema
			: { ...document.schema, $defs: document.definitions }
	) as JSONSchema7;
	const decode = Schema.decodeUnknownResult(effectSchema);
	return jsonSchema<Schema.Schema.Type<S>>(flattened, {
		validate: (value) =>
			Result.match(decode(value), {
				onSuccess: (decoded) => ({
					success: true as const,
					value: decoded as Schema.Schema.Type<S>,
				}),
				onFailure: (error) => ({
					success: false as const,
					error: new Error(error.message),
				}),
			}),
	});
};

/**
 * What the two output tools are called. Separate from the tools themselves
 * because one adapter can't accept the default names — see
 * `WALKTHROUGH_TOOL_NAMES` below — and whatever names are used have to reach
 * the system prompt too, so the model is told the same ones the harness
 * registers.
 */
export type WalkthroughToolNames = {
	readonly write: string;
	readonly edit: string;
};

/**
 * Deliberately distinct from every adapter's builtin file tools rather than
 * colliding with them. Overriding `write`/`edit` by key collision used to be
 * the design — `HarnessAgentSettings.tools` documents user tools as winning a
 * collision — but it failed two different ways in practice:
 *
 *   - Pi doesn't honor the precedence at all. It registers its seven native
 *     builtins *and* the user tools into one set, so the call dispatches but
 *     the user tool's pending-result promise is never resolved and the turn
 *     hangs forever with no timeout. Confirmed live: renaming completes the
 *     same turn in ~12s.
 *   - Claude Code honored it on a small prompt and then, on a 222-file context
 *     payload, ran its *builtin* `Write` instead — leaving a stray `walkthrough.json`
 *     in the user's repo root while our buffer stayed empty for all four
 *     turns. A name that means two different things is exactly what drifts
 *     under load.
 *
 * A name nothing else claims can't be shadowed or mistaken either way. The
 * builtins are separately switched off (`sidecar/walkthrough/generate.ts`'s
 * `inactiveTools`), so nothing the model can call writes to the worktree.
 */
export const WALKTHROUGH_TOOL_NAMES: WalkthroughToolNames = {
	write: "write_walkthrough",
	edit: "edit_walkthrough",
};

/**
 * The agent's output tools, bound to one buffer. Always keyed `write`/`edit`
 * here regardless of `names` — the caller re-keys when handing them to a
 * harness (see `generate.ts`), which keeps this return type statically
 * checkable instead of collapsing to an index signature. `names` only feeds
 * the descriptions, so each tool refers to the other by the name the model
 * was actually given.
 */
export const createWalkthroughTools = (
	buffer: WalkthroughBuffer,
	names: WalkthroughToolNames = WALKTHROUGH_TOOL_NAMES,
) => ({
	write: tool({
		description: `Write the complete walkthrough document, replacing any existing content. Prefer \`${names.edit}\` for small revisions once a draft exists.`,
		inputSchema: toToolInputSchema(WriteInput),
		execute: async (input: Schema.Schema.Type<typeof WriteInput>) => {
			buffer.content = input.content;
			return "Wrote the walkthrough buffer.";
		},
	}),
	edit: tool({
		description: `Replace one exact string with another in the walkthrough buffer — the same semantics as your own file-editing tool, applied to this one document instead of a file. Use this for targeted revisions instead of rewriting the whole document with \`${names.write}\`.`,
		inputSchema: toToolInputSchema(EditInput),
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
