import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const isMissing = (error: unknown): boolean =>
	error instanceof Object && "code" in error && error.code === "ENOENT";

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isMissing(error)) return false;
		throw error;
	}
};

/** @ai-sdk/harness trusts markers alone (bootstrap-recipe.ts:113–118); node_modules cleanup sweeps under ~/.nisi leave markers behind and brick chat/walkthrough with missing ws. */
export const invalidateStaleBootstraps = async (
	defaultWorkingDirectory: string,
): Promise<void> => {
	const bootstrapRoot = join(defaultWorkingDirectory, ".harness-bootstrap");
	const directories = await readdir(bootstrapRoot, {
		withFileTypes: true,
	}).catch((error: unknown) => {
		if (isMissing(error)) return [];
		throw error;
	});
	for (const directory of directories) {
		if (!directory.isDirectory()) continue;
		const bootstrapDir = join(bootstrapRoot, directory.name);
		if (!(await isFile(join(bootstrapDir, "package.json")))) continue;
		if (await isFile(join(bootstrapDir, "node_modules", ".modules.yaml"))) {
			continue;
		}
		const entries = await readdir(bootstrapDir);
		const markers = entries.filter((name) => /^\.bootstrap-.*\.ok$/.test(name));
		if (markers.length === 0) continue;
		for (const marker of markers) {
			await unlink(join(bootstrapDir, marker));
		}
		console.warn(
			`Invalidated stale harness bootstrap markers: ${bootstrapDir}`,
		);
	}
};
