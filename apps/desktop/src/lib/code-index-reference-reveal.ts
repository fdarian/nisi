import type { CodeIndexReferenceTarget } from "#/lib/code-index-navigation";

export type CodeIndexReferenceRevealTransaction<Instance> = {
	targetKey: string;
	instance: Instance | undefined;
	revealed: boolean;
	applied: boolean;
	centered: boolean;
};

/** Identifies the exact target so a second navigation starts a new transaction. */
export function codeIndexReferenceRevealTargetKey(
	target: CodeIndexReferenceTarget,
): string {
	return [target.path, target.line, target.charStart, target.charEnd].join(
		"\u0000",
	);
}

export function createCodeIndexReferenceRevealTransaction<Instance>(
	targetKey: string,
): CodeIndexReferenceRevealTransaction<Instance> {
	return {
		targetKey,
		instance: undefined,
		revealed: false,
		applied: false,
		centered: false,
	};
}

/** Resets the transaction when either the target or the concrete CodeView changes. */
export function syncCodeIndexReferenceRevealTransaction<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance> | undefined,
	targetKey: string,
	instance: Instance | undefined,
): CodeIndexReferenceRevealTransaction<Instance> {
	if (
		transaction !== undefined &&
		transaction.targetKey === targetKey &&
		transaction.instance === instance
	) {
		return transaction;
	}
	return {
		targetKey,
		instance,
		revealed: false,
		applied: false,
		centered: false,
	};
}

export function markCodeIndexReferenceRevealed<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance>,
	instance: Instance,
): CodeIndexReferenceRevealTransaction<Instance> {
	if (transaction.instance !== instance) return transaction;
	return { ...transaction, revealed: true };
}

export function markCodeIndexReferenceApplied<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance>,
	instance: Instance,
): CodeIndexReferenceRevealTransaction<Instance> {
	if (transaction.instance !== instance) return transaction;
	return { ...transaction, applied: true };
}

export function markCodeIndexReferenceCentered<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance>,
	instance: Instance,
): CodeIndexReferenceRevealTransaction<Instance> {
	if (transaction.instance !== instance) return transaction;
	return { ...transaction, centered: true };
}

export function shouldRevealCodeIndexReference<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance>,
	instance: Instance,
): boolean {
	return transaction.instance === instance && !transaction.revealed;
}

export function canClearCodeIndexReferenceReveal<Instance>(
	transaction: CodeIndexReferenceRevealTransaction<Instance>,
	instance: Instance,
): boolean {
	return (
		transaction.instance === instance &&
		transaction.revealed &&
		transaction.applied &&
		transaction.centered
	);
}
