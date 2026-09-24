import type { FileContents } from "@pierre/diffs";

export function resolvePlaceholderFile(
	cache: Map<string, FileContents>,
	path: string,
	cacheKey: string,
	contents = " ",
): FileContents {
	const cached = cache.get(path);
	if (
		cached !== undefined &&
		cached.cacheKey === cacheKey &&
		cached.contents === contents
	)
		return cached;

	const file: FileContents = {
		name: path,
		contents,
		lang: "text",
		cacheKey,
	};
	cache.set(path, file);
	return file;
}
