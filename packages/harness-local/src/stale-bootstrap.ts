import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isEnoent } from "./is-enoent.ts";

const isFile = async (path: string): Promise<boolean> => {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isEnoent(error)) return false;
		throw error;
	}
};

/**
 * @ai-sdk/harness's applyBootstrapRecipe in bootstrap-recipe.ts trusts markers
 * alone. node_modules cleanup sweeps under ~/.nisi leave markers behind and
 * brick chat/walkthrough with missing ws.
 */
export const invalidateStaleBootstraps = async (
	defaultWorkingDirectory: string,
): Promise<void> => {
	const bootstrapRoot = join(defaultWorkingDirectory, ".harness-bootstrap");
	const directories = await readdir(bootstrapRoot, {
		withFileTypes: true,
	}).catch((error: unknown) => {
		if (isEnoent(error)) return [];
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
	}
};
