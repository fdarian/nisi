import { resolve } from "node:path";

export function parseLaunchOptions(argv: readonly string[]) {
	const options: {
		cwd?: string;
		cold: boolean;
		newPr: boolean;
		warmup?: string;
		deeplink?: string;
		rebuild: boolean;
		json: boolean;
		waitPrIndex: boolean;
	} = {
		cold: false,
		newPr: false,
		rebuild: false,
		json: false,
		waitPrIndex: false,
	};
	for (const [index, arg] of argv.entries()) {
		if (
			index > 0 &&
			(argv[index - 1] === "--cwd" ||
				argv[index - 1] === "--warmup" ||
				argv[index - 1] === "--deeplink")
		)
			continue;
		if (arg === "--cwd" || arg === "--warmup" || arg === "--deeplink") {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error(`${arg} requires a PR worktree path`);
			if (arg === "--cwd") options.cwd = resolve(value);
			else if (arg === "--deeplink") options.deeplink = value;
			else
				options.warmup = argv.includes("--deeplink") ? value : resolve(value);
		} else if (arg === "--cold") options.cold = true;
		else if (arg === "--new-pr") options.newPr = true;
		else if (arg === "--rebuild") options.rebuild = true;
		else if (arg === "--json") options.json = true;
		else if (arg === "--wait-pr-index") options.waitPrIndex = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (options.cwd === undefined)
		throw new Error(
			"Usage: bun scripts/measure-launch --cwd <pr worktree> [--cold] [--rebuild] [--json]",
		);
	if (options.cold && options.newPr)
		throw new Error("--cold and --new-pr are mutually exclusive");
	if (options.deeplink !== undefined && !options.cold && !options.newPr)
		throw new Error(
			"--deeplink requires a managed --cold or --new-pr instance",
		);
	if (options.newPr && options.warmup === undefined)
		throw new Error("--new-pr requires --warmup <other PR worktree>");
	if (!options.newPr && options.warmup !== undefined)
		throw new Error("--warmup requires --new-pr");
	if (options.waitPrIndex && !options.newPr)
		throw new Error("--wait-pr-index requires --new-pr");
	if (options.rebuild && !options.cold && !options.newPr)
		throw new Error("--rebuild requires --cold or --new-pr");
	return { ...options, cwd: options.cwd };
}
