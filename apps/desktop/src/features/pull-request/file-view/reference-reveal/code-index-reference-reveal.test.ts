import { describe, expect, test } from "bun:test";
import type { CodeIndexReferenceTarget } from "#/features/code-index/navigation/code-index-navigation";
import {
	canClearCodeIndexReferenceReveal,
	codeIndexReferenceRevealTargetKey,
	createCodeIndexReferenceRevealTransaction,
	markCodeIndexReferenceApplied,
	markCodeIndexReferenceCentered,
	markCodeIndexReferenceRevealed,
	shouldRevealCodeIndexReference,
	syncCodeIndexReferenceRevealTransaction,
} from "./code-index-reference-reveal";

const target: CodeIndexReferenceTarget = {
	path: "src/example.ts",
	line: 10,
	charStart: 4,
	charEnd: 15,
};

describe("code-index reference reveal transactions", () => {
	test("tracks reveal, application, centering, and completion", () => {
		const targetKey = codeIndexReferenceRevealTargetKey(target);
		const pending =
			createCodeIndexReferenceRevealTransaction<string>(targetKey);
		const attached = syncCodeIndexReferenceRevealTransaction(
			pending,
			targetKey,
			"first",
		);

		const revealed = markCodeIndexReferenceRevealed(attached, "first");
		const applied = markCodeIndexReferenceApplied(revealed, "first");
		const centered = markCodeIndexReferenceCentered(applied, "first");

		expect(shouldRevealCodeIndexReference(centered, "first")).toBe(false);
		expect(canClearCodeIndexReferenceReveal(centered, "first")).toBe(true);
	});

	test("requires a second reveal when the CodeView instance is replaced", () => {
		const targetKey = codeIndexReferenceRevealTargetKey(target);
		const attached = syncCodeIndexReferenceRevealTransaction(
			createCodeIndexReferenceRevealTransaction<string>(targetKey),
			targetKey,
			"first",
		);
		const revealed = markCodeIndexReferenceRevealed(attached, "first");

		const replacement = syncCodeIndexReferenceRevealTransaction(
			revealed,
			targetKey,
			"replacement",
		);

		expect(shouldRevealCodeIndexReference(replacement, "replacement")).toBe(
			true,
		);
		expect(canClearCodeIndexReferenceReveal(replacement, "replacement")).toBe(
			false,
		);
	});

	test("starts a new transaction for a different target", () => {
		const firstKey = codeIndexReferenceRevealTargetKey(target);
		const secondKey = codeIndexReferenceRevealTargetKey({
			...target,
			line: target.line + 1,
		});
		const first = syncCodeIndexReferenceRevealTransaction(
			createCodeIndexReferenceRevealTransaction<string>(firstKey),
			firstKey,
			"viewer",
		);

		const second = syncCodeIndexReferenceRevealTransaction(
			first,
			secondKey,
			"viewer",
		);

		expect(second.targetKey).toBe(secondKey);
		expect(shouldRevealCodeIndexReference(second, "viewer")).toBe(true);
	});
});
