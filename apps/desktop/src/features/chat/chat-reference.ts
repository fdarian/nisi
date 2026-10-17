import {
	type DiffSelectionReference,
	formatSelectionReference,
	formatSelectionReferenceShort,
} from "#/features/diff/diff-reference";

export type ExcerptReference = {
	kind: "excerpt";
	source: "description" | "guide";
	/** Text of the nearest heading above the selection, when there is one. */
	section: string | undefined;
	text: string;
};

/** Anything the user can attach to a chat thread as a chip with "Ask". */
export type ChatReference = DiffSelectionReference | ExcerptReference;

const SHORT_EXCERPT_LENGTH = 24;

/** Same-selection identity for dedup — two "Ask" clicks on the same lines, or the same excerpt text from the same source, are one chip. */
export function chatReferencesEqual(
	a: ChatReference,
	b: ChatReference,
): boolean {
	if (a.kind === "lines" && b.kind === "lines") {
		return (
			a.path === b.path &&
			a.startLine === b.startLine &&
			a.endLine === b.endLine
		);
	}
	if (a.kind === "excerpt" && b.kind === "excerpt") {
		return a.source === b.source && a.text === b.text;
	}
	return false;
}

function formatExcerptForAgent(reference: ExcerptReference): string {
	const origin =
		reference.source === "description"
			? "the PR description"
			: "the reviewer guide (.nisi/guide/guide.mdx)";
	const section =
		reference.section === undefined ? "" : `, under "${reference.section}"`;
	const quoted = reference.text
		.trim()
		.replace(/\n{3,}/g, "\n\n")
		.split("\n")
		.map((line) => (line.trim() === "" ? ">" : `> ${line}`))
		.join("\n");
	return `Excerpt from ${origin}${section}:\n${quoted}`;
}

/** What one reference looks like inside the message the agent receives. */
export function formatChatReferenceForAgent(reference: ChatReference): string {
	return reference.kind === "lines"
		? formatSelectionReference(reference)
		: formatExcerptForAgent(reference);
}

/** The outgoing message: every reference's agent-facing block, then the user's own text. */
export function composeOutgoingMessage(
	references: readonly ChatReference[],
	text: string,
): string {
	if (references.length === 0) return text;
	return `${references.map(formatChatReferenceForAgent).join("\n\n")}\n\n${text}`;
}

/** Chip label — too narrow for the full form, so `formatChatReferenceForAgent` goes in the `title`. */
export function formatChatReferenceShort(reference: ChatReference): string {
	if (reference.kind === "lines")
		return formatSelectionReferenceShort(reference);
	const label = reference.source === "description" ? "Description" : "Guide";
	const flat = reference.text.replace(/\s+/g, " ").trim();
	const preview =
		flat.length <= SHORT_EXCERPT_LENGTH
			? flat
			: `${flat.slice(0, SHORT_EXCERPT_LENGTH).trimEnd()}…`;
	return `${label}: “${preview}”`;
}
