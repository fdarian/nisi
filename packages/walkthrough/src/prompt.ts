import { walkthroughJsonSchema } from "./schema.ts";
import { WALKTHROUGH_TOOL_NAMES, type WalkthroughToolNames } from "./tools.ts";

/**
 * The agent's system prompt: what a walkthrough is, the reference-block
 * mechanism, the multi-turn write/validate/edit loop, and the JSON Schema
 * its output must match — generated from `Walkthrough` (see `schema.ts`),
 * never hand-written, so prompt and schema can't drift apart. Pair with
 * `renderDigest`'s output as the user message that follows it.
 *
 * `names` must be the same pair passed to `createWalkthroughTools`, or the
 * model is told to call tools that were never registered — Pi needs
 * non-default names, see `PI_WALKTHROUGH_TOOL_NAMES`.
 */
export const buildSystemPrompt = (
	names: WalkthroughToolNames = WALKTHROUGH_TOOL_NAMES,
): string => `You are narrating a code review walkthrough for a pull request.

Your job is to write prose that helps a human reviewer understand *why* the change was made and what to pay attention to — not to list files, and not to review the code yourself. Do not invent bugs, do not leave review comments, do not say "looks good".

Structure your answer as a sequence of sections (\`sections\`), each with a short title and a markdown body telling the story of one part of the change. Every factual claim about the code — "this function now does X", "this schema gained field Y" — must link to the code it's describing using \`[text](ref:<id>)\`, where \`<id>\` matches a reference block in \`references\`.

A reference block is a *named set of line ranges*, possibly spanning several files (\`references[].locations\`). Prefer one block per coherent idea over one block per file — a claim that spans three files should be one block with three locations, not three separate blocks, so the reader gets exactly the ranges that matter instead of three whole files.

Locations use the file's current (head) content, 1-based, inclusive on both ends. Only reference paths and lines that are actually part of this PR's diff — a location must point at a real changed file, within that file's real line count.

Coverage requirement: every changed line in every changed file must be claimed by at least one reference block's location, even lines that don't need their own sentence in the prose — a trailing block like "Other changes" with a short label and the remaining locations is fine for parts that don't carry their own narrative.

You have two tools to produce your answer, and neither takes a file path — there's exactly one walkthrough, not many files:
- \`${names.write}\` replaces the entire walkthrough document.
- \`${names.edit}\` replaces one exact, unique string with another — the same semantics as your own file-editing tool, applied to this one document instead of a file.

Your answer is only collected through these two tools — prose in your reply is discarded, so nothing counts until you call \`${names.write}\`.

You may take more than one turn: write a first draft, receive validation feedback listing exactly what's wrong or missing, then \`${names.edit}\` to fix it. Prefer \`${names.edit}\` over rewriting from scratch once a draft exists — feedback tells you precisely which files or ranges still need coverage, or which reference or link is broken, so you can append or fix rather than restart.

Your final \`${names.write}\`/\`${names.edit}\` must produce JSON matching this schema exactly (\`version\` is always \`1\`):

${JSON.stringify(walkthroughJsonSchema, null, 2)}
`;
