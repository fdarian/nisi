import { resolve } from "node:path";

export function parseLaunchOptions(argv: readonly string[]) {
	const options: {
		cwd?: string;
		cold: boolean;
		rebuild: boolean;
		json: boolean;
	} = {
		cold: false,
		rebuild: false,
		json: false,
	};
	for (const [index, arg] of argv.entries()) {
		if (index > 0 && argv[index - 1] === "--cwd") continue;
		if (arg === "--cwd") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error("--cwd requires a PR worktree path");
			options.cwd = resolve(value);
		} else if (arg === "--cold") options.cold = true;
		else if (arg === "--rebuild") options.rebuild = true;
		else if (arg === "--json") options.json = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (options.cwd === undefined)
		throw new Error(
			"Usage: bun scripts/measure-launch.ts --cwd <pr worktree> [--cold] [--rebuild] [--json]",
		);
	if (options.rebuild && !options.cold)
		throw new Error("--rebuild requires --cold");
	return { ...options, cwd: options.cwd };
}
