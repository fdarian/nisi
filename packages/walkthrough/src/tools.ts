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
			"The complete walkthrough document, replacing any existing content. Must be a markdown document in the format described in the system prompt: narrative sections opened with `## `, followed by a single ```references fenced block.",
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
 * Hand-written rather than derived from an Effect `Schema.Struct({})` through
 * `toToolInputSchema` below — checked live, `Schema.toJsonSchemaDocument`
 * turns a zero-field struct into `{ anyOf: [{ type: "object" }, { type:
 * "array" }] }`, not `{ type: "object", properties: {} }`. That's not the
 * literal empty-schema failure `toToolInputSchema`'s own doc describes, but
 * it's just as unhelpful for a no-argument tool: it tells the model (and any
 * MCP-driving adapter) that almost any shape is a valid call, instead of "no
 * parameters at all."
 */
const READ_INPUT_JSON_SCHEMA: JSONSchema7 = {
	type: "object",
	properties: {},
	additionalProperties: false,
};

/**
 * `read` takes no arguments and never fails validation — there's nothing in
 * an empty object to reject, and a spurious validation failure would burn
 * one of the agent's few turns on a tool that only ever reads state back.
 */
const readInputSchema = jsonSchema<Record<string, never>>(
	READ_INPUT_JSON_SCHEMA,
	{
		validate: () => ({
			success: true as const,
			value: {} as Record<string, never>,
		}),
	},
);

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
 * What the three tools are called. Separate from the tools themselves because
 * one adapter can't accept the default names — see `WALKTHROUGH_TOOL_NAMES`
 * below — and whatever names are used have to reach the system prompt too, so
 * the model is told the same ones the harness registers.
 */
export type WalkthroughToolNames = {
	readonly write: string;
	readonly edit: string;
	readonly read: string;
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
	read: "read_walkthrough",
};

/**
 * The agent's tools, bound to one buffer. Always keyed `write`/`edit`/`read`
 * here regardless of `names` — the caller re-keys when handing them to a
 * harness (see `generate.ts`), which keeps this return type statically
 * checkable instead of collapsing to an index signature. `names` only feeds
 * the descriptions, so each tool refers to the others by the names the model
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
		description: `Replace one exact string with another in the walkthrough buffer — the same semantics as your own file-editing tool, applied to this one document instead of a file. Use this for targeted revisions instead of rewriting the whole document with \`${names.write}\`. Call \`${names.read}\` first if you're not sure of the buffer's exact current text.`,
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
	read: tool({
		description: `Read the walkthrough buffer's exact current text, unmodified — no added line numbers. Use this to re-sync on the precise bytes \`${names.edit}\`'s oldString must match, especially before an edit whose surrounding text you're not certain of.`,
		inputSchema: readInputSchema,
		execute: async () =>
			buffer.content.length === 0
				? "The walkthrough buffer is empty — nothing has been written yet."
				: buffer.content,
	}),
});
