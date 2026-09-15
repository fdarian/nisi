import { describe, expect, test } from "bun:test";
import type { CodeIndexReferenceTarget } from "#/lib/code-index-navigation";
import {
	canClearCodeIndexReferenceReveal,
	codeIndexReferenceRevealTargetKey,
	createCodeIndexReferenceRevealTransaction,
	markCodeIndexReferenceApplied,
	markCodeIndexReferenceCentered,
	markCodeIndexReferenceRevealed,
	shouldRevealCodeIndexReference,
	syncCodeIndexReferenceRevealTransaction,
} from "#/lib/code-index-reference-reveal";

const target: CodeIndexReferenceTarget = {
	path: "src/example.ts",
	line: 10,
	charStart: 4,
	charEnd: 15,
};

describe("code-index reference reveal transactions", () => {
	test("tracks reveal, application, centering, and completion", () => {
		const targetKey = codeIndexReferenceRevealTargetKey(target);
		let transaction =
			createCodeIndexReferenceRevealTransaction<string>(targetKey);
		transaction = syncCodeIndexReferenceRevealTransaction(
			transaction,
			targetKey,
			"first",
		);

		expect(shouldRevealCodeIndexReference(transaction, "first")).toBe(true);
		transaction = markCodeIndexReferenceRevealed(transaction, "first");
		transaction = markCodeIndexReferenceApplied(transaction, "first");
		transaction = markCodeIndexReferenceCentered(transaction, "first");

		expect(shouldRevealCodeIndexReference(transaction, "first")).toBe(false);
		expect(canClearCodeIndexReferenceReveal(transaction, "first")).toBe(true);
	});

	test("requires a second reveal when the CodeView instance is replaced", () => {
		const targetKey = codeIndexReferenceRevealTargetKey(target);
		let transaction = syncCodeIndexReferenceRevealTransaction(
			createCodeIndexReferenceRevealTransaction<string>(targetKey),
			targetKey,
			"first",
		);
		transaction = markCodeIndexReferenceRevealed(transaction, "first");

		transaction = syncCodeIndexReferenceRevealTransaction(
			transaction,
			targetKey,
			"replacement",
		);

		expect(shouldRevealCodeIndexReference(transaction, "replacement")).toBe(
			true,
		);
		expect(canClearCodeIndexReferenceReveal(transaction, "replacement")).toBe(
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
