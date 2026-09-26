export const FILE_CONTENTS_CHUNK_SIZE = 30;

export function demandedFileContentChunks(
	paths: readonly string[],
	renderedPaths: readonly string[],
	selectedPath: string | null,
	searchAll: boolean,
): ReadonlySet<number> {
	const demanded = new Set<number>();
	const chunkByPath = new Map(
		paths.map(
			(path, index) =>
				[path, Math.floor(index / FILE_CONTENTS_CHUNK_SIZE)] as const,
		),
	);
	if (searchAll) {
		for (const chunk of chunkByPath.values()) demanded.add(chunk);
		return demanded;
	}

	for (const path of renderedPaths) {
		const chunk = chunkByPath.get(path);
		if (chunk !== undefined) demanded.add(chunk);
	}
	const lastRenderedPath = renderedPaths[renderedPaths.length - 1];
	const lastRenderedChunk =
		lastRenderedPath === undefined
			? undefined
			: chunkByPath.get(lastRenderedPath);
	if (
		lastRenderedChunk !== undefined &&
		(lastRenderedChunk + 1) * FILE_CONTENTS_CHUNK_SIZE < paths.length
	) {
		demanded.add(lastRenderedChunk + 1);
	}
	if (selectedPath !== null) {
		const selectedChunk = chunkByPath.get(selectedPath);
		if (selectedChunk !== undefined) demanded.add(selectedChunk);
	}
	return demanded;
}
