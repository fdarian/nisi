import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "smol-toml";

// `packages/db/src/paths.ts` implements the same rules for the sidecar and CLI — change both together.

const CONFIG_KEYS = ["data_dir"];

export function parseConfig(
	contents: string,
	configPath: string,
	home: string,
): string | null {
	let config: Record<string, unknown>;
	try {
		config = parse(contents);
	} catch (e) {
		throw new Error(`${configPath} is invalid: ${errorMessage(e)}`);
	}
	for (const key of Object.keys(config)) {
		if (!CONFIG_KEYS.includes(key)) {
			throw new Error(`${configPath} is invalid: unknown field \`${key}\``);
		}
	}
	const raw = config.data_dir;
	if (raw === undefined) {
		return null;
	}
	if (typeof raw !== "string") {
		throw new Error(
			`${configPath} is invalid: data_dir must be a string, got ${typeof raw}`,
		);
	}
	const expanded = raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	if (!isAbsolute(expanded)) {
		throw new Error(
			`${configPath}: data_dir must be an absolute path (or start with ~/), got "${raw}"`,
		);
	}
	return expanded;
}

/** `NISI_DATA_DIR`, else `data_dir` in `~/.config/nisi/config.toml`, else `null` (the caller's own default). */
export function resolveDataDirOverride(env: NodeJS.ProcessEnv): string | null {
	const fromEnv = env.NISI_DATA_DIR;
	if (fromEnv !== undefined) {
		return fromEnv;
	}
	const home = env.HOME;
	if (home === undefined) {
		throw new Error("could not resolve $HOME: environment variable not found");
	}
	const configPath = join(home, ".config", "nisi", "config.toml");
	let contents: string;
	try {
		contents = readFileSync(configPath, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			return null;
		}
		throw new Error(`could not read ${configPath}: ${errorMessage(e)}`);
	}
	return parseConfig(contents, configPath, home);
}

function errorMessage(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}
