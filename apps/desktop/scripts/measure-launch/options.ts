import { resolve } from "node:path";

const missingValue: Record<string, string> = {
	"--cwd": "--cwd requires a PR worktree path",
	"--warmup": "--warmup requires a PR worktree path",
	"--deeplink": "--deeplink requires a PR worktree path",
	"--runs": "--runs requires a whole number of at least 1",
	"--memory-settle": "--memory-settle requires a number of milliseconds",
	"--soak-prs": "--soak-prs requires a comma-separated list of PR URLs",
	"--soak-interval": "--soak-interval requires a number of milliseconds",
	"--soak-idle": "--soak-idle requires a number of milliseconds",
};

function parseWholeNumber(flag: string, value: string, minimum: number) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum)
		throw new Error(missingValue[flag] as string);
	return parsed;
}

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
		memory: boolean;
		memorySettleMs: number;
		soak: boolean;
		soakPrs: string[];
		soakIntervalMs: number;
		soakIdleMs: number;
		runs?: number;
		discardFirst: boolean;
	} = {
		cold: false,
		newPr: false,
		rebuild: false,
		json: false,
		waitPrIndex: false,
		memory: false,
		memorySettleMs: 5000,
		soak: false,
		soakPrs: [],
		soakIntervalMs: 2000,
		soakIdleMs: 60_000,
		discardFirst: false,
	};
	let memorySettleGiven = false;
	const soakFlagsGiven: string[] = [];
	for (const [index, arg] of argv.entries()) {
		const previous = argv[index - 1];
		if (previous !== undefined && Object.hasOwn(missingValue, previous))
			continue;
		if (Object.hasOwn(missingValue, arg)) {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith("--"))
				throw new Error(missingValue[arg] as string);
			if (arg === "--cwd") options.cwd = resolve(value);
			else if (arg === "--deeplink") options.deeplink = value;
			else if (arg === "--runs") options.runs = parseWholeNumber(arg, value, 1);
			else if (arg === "--memory-settle") {
				options.memorySettleMs = parseWholeNumber(arg, value, 0);
				memorySettleGiven = true;
			} else if (arg === "--soak-prs") {
				options.soakPrs = value
					.split(",")
					.map((url) => url.trim())
					.filter((url) => url.length > 0);
				if (options.soakPrs.length === 0)
					throw new Error(missingValue[arg] as string);
				soakFlagsGiven.push(arg);
			} else if (arg === "--soak-interval") {
				options.soakIntervalMs = parseWholeNumber(arg, value, 100);
				soakFlagsGiven.push(arg);
			} else if (arg === "--soak-idle") {
				options.soakIdleMs = parseWholeNumber(arg, value, 0);
				soakFlagsGiven.push(arg);
			} else
				options.warmup = argv.includes("--deeplink") ? value : resolve(value);
		} else if (arg === "--memory") options.memory = true;
		else if (arg === "--soak") options.soak = true;
		else if (arg === "--discard-first") options.discardFirst = true;
		else if (arg === "--cold") options.cold = true;
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
	if (memorySettleGiven && !options.memory)
		throw new Error("--memory-settle requires --memory");
	if (soakFlagsGiven.length > 0 && !options.soak)
		throw new Error(`${soakFlagsGiven[0]} requires --soak`);
	if (options.soak && (!options.cold || options.deeplink === undefined))
		throw new Error("--soak requires --cold and --deeplink");
	if (options.runs !== undefined && !options.cold)
		throw new Error("--runs requires --cold");
	if (options.discardFirst && options.runs === undefined)
		throw new Error("--discard-first requires --runs");
	if (options.discardFirst && (options.runs as number) < 2)
		throw new Error("--discard-first requires --runs of at least 2");
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
