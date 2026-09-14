import type {
	CodeIndexFileReferences,
	CodeIndexReference,
} from "@repo/sidecar-api";
import type { CodeIndexPeekTarget } from "#/components/code-index/use-code-index-interactions";

export type ReferenceNavigationGroup = {
	path: string;
	references: readonly CodeIndexReference[];
	open: boolean;
};

export type VisibleReference = {
	id: string;
	index: number;
	groupIndex: number;
	referenceIndex: number;
	path: string;
	reference: CodeIndexReference;
};

export function referenceNavigationGroup(
	group: CodeIndexFileReferences,
	open: boolean,
): ReferenceNavigationGroup {
	return {
		path: group.path,
		references: group.references,
		open,
	};
}

export function referenceRowId(
	path: string,
	reference: CodeIndexReference,
	referenceIndex: number,
): string {
	return `${path}:${reference.line}:${reference.charStart}:${reference.charEnd}:${referenceIndex}`;
}

export function flattenVisibleReferences(
	groups: readonly ReferenceNavigationGroup[],
): readonly VisibleReference[] {
	const visibleReferences: VisibleReference[] = [];

	for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
		const group = groups[groupIndex];
		if (group === undefined || !group.open) continue;

		for (
			let referenceIndex = 0;
			referenceIndex < group.references.length;
			referenceIndex += 1
		) {
			const reference = group.references[referenceIndex];
			if (reference === undefined) continue;

			visibleReferences.push({
				id: referenceRowId(group.path, reference, referenceIndex),
				index: visibleReferences.length,
				groupIndex,
				referenceIndex,
				path: group.path,
				reference,
			});
		}
	}

	return visibleReferences;
}

export function moveReferenceIndex(
	currentIndex: number | undefined,
	direction: -1 | 1,
	count: number,
): number | undefined {
	if (count === 0) return undefined;

	const start =
		currentIndex === undefined
			? direction > 0
				? 0
				: count - 1
			: currentIndex + direction;
	return Math.min(count - 1, Math.max(0, start));
}

export function initialReferenceIndex(
	visibleReferences: readonly VisibleReference[],
	target: CodeIndexPeekTarget,
): number | undefined {
	if (visibleReferences.length === 0) return undefined;

	const clickedIndex = visibleReferences.findIndex((item) => {
		if (item.path !== target.path) return false;
		if (item.reference.line !== target.occurrence.line) return false;
		return (
			item.reference.charStart <= target.occurrence.charEnd &&
			item.reference.charEnd >= target.occurrence.charStart
		);
	});

	return clickedIndex === -1 ? 0 : clickedIndex;
}
