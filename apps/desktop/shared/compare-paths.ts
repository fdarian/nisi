/** Directories precede files at each level, matching the diff viewer's tree order. */
export function comparePaths(a: string, b: string): number {
	const left = a.split("/");
	const right = b.split("/");
	for (let index = 0; index < Math.min(left.length, right.length); index++) {
		const leftSegment = left[index];
		const rightSegment = right[index];
		if (leftSegment === undefined || rightSegment === undefined)
			throw new Error("path segment missing within bounds");
		if (leftSegment === rightSegment) continue;
		const leftDirectory = index < left.length - 1;
		const rightDirectory = index < right.length - 1;
		if (leftDirectory !== rightDirectory) return leftDirectory ? -1 : 1;
		return leftSegment.localeCompare(rightSegment);
	}
	return left.length - right.length;
}
