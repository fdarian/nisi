import { describe, expect, test } from "bun:test";
import {
	type ChatReference,
	chatReferencesEqual,
	composeOutgoingMessage,
	type ExcerptReference,
	formatChatReferenceForAgent,
	formatChatReferenceShort,
	formatChatReferenceTitle,
} from "./chat-reference";

const lines: ChatReference = {
	kind: "lines",
	path: "src/a/b.ts",
	startLine: 1,
	endLine: 3,
};

const excerpt: ExcerptReference = {
	kind: "excerpt",
	source: "description",
	section: "Testing",
	text: "first line\n\n\n\nsecond paragraph",
};

describe("formatChatReferenceForAgent", () => {
	test("lines keep the path#L form", () => {
		expect(formatChatReferenceForAgent(lines)).toBe("src/a/b.ts#L1-3");
	});

	test("description excerpt is a header plus a blockquote", () => {
		expect(formatChatReferenceForAgent(excerpt)).toBe(
			'Excerpt from the PR description, under "Testing":\n> first line\n>\n> second paragraph',
		);
	});

	test("guide excerpt names the guide file", () => {
		expect(
			formatChatReferenceForAgent({
				...excerpt,
				source: "guide",
				section: "Overview",
				text: "hello",
			}),
		).toBe(
			'Excerpt from the reviewer guide (.nisi/guide/guide.mdx), under "Overview":\n> hello',
		);
	});

	test("no section drops the under clause", () => {
		expect(
			formatChatReferenceForAgent({
				...excerpt,
				section: undefined,
				text: "hi",
			}),
		).toBe("Excerpt from the PR description:\n> hi");
	});

	test("text is trimmed", () => {
		expect(
			formatChatReferenceForAgent({ ...excerpt, text: "\n  hi there \n\n" }),
		).toBe('Excerpt from the PR description, under "Testing":\n> hi there');
	});
});

describe("composeOutgoingMessage", () => {
	test("no references is the text unchanged", () => {
		expect(composeOutgoingMessage([], "why?")).toBe("why?");
	});

	test("blocks are separated by a blank line, then the text", () => {
		expect(composeOutgoingMessage([lines, excerpt], "why?")).toBe(
			'src/a/b.ts#L1-3\n\nExcerpt from the PR description, under "Testing":\n> first line\n>\n> second paragraph\n\nwhy?',
		);
	});
});

describe("chip labels", () => {
	test("lines use the basename", () => {
		expect(formatChatReferenceShort(lines)).toBe("b.ts#L1-3");
		expect(formatChatReferenceTitle(lines)).toBe("src/a/b.ts#L1-3");
	});

	test("excerpt label collapses whitespace and truncates", () => {
		expect(formatChatReferenceShort(excerpt)).toBe(
			"Description: “first line second paragr…”",
		);
		expect(
			formatChatReferenceShort({
				...excerpt,
				source: "guide",
				text: "short\ntext",
			}),
		).toBe("Guide: “short text”");
	});

	test("excerpt title is the agent-facing form", () => {
		expect(formatChatReferenceTitle(excerpt)).toBe(
			formatChatReferenceForAgent(excerpt),
		);
	});
});

describe("chatReferencesEqual", () => {
	test("lines compare by path and range", () => {
		expect(chatReferencesEqual(lines, { ...lines })).toBe(true);
		expect(
			chatReferencesEqual(lines, { ...lines, endLine: 4 } as ChatReference),
		).toBe(false);
	});

	test("excerpts compare by source and text, ignoring section", () => {
		expect(chatReferencesEqual(excerpt, { ...excerpt, section: "Other" })).toBe(
			true,
		);
		expect(chatReferencesEqual(excerpt, { ...excerpt, source: "guide" })).toBe(
			false,
		);
	});

	test("different kinds are never equal", () => {
		expect(chatReferencesEqual(lines, excerpt)).toBe(false);
	});
});
