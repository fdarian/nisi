export function appProcessIds(
	output: string,
	appPaths: readonly string[],
): number[] {
	return output
		.split("\n")
		.filter((line) =>
			appPaths.some(
				(appPath) =>
					line.trim().replace(/^\d+\s+/, "") ===
					`${appPath}/Contents/MacOS/nisi`,
			),
		)
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}
