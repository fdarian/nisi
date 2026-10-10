import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { Config, ConfigProvider, Effect } from "effect";

const configFileDataDirKey = "data_dir";

const failConfig = (message: string, cause?: unknown) =>
	Effect.fail(
		new Config.ConfigError(new ConfigProvider.SourceError({ message, cause })),
	);

export const getConfigFilePath = (): string =>
	join(homedir(), ".config", "nisi", "config.toml");

/**
 * Reads `data_dir` from the user's `config.toml`. A missing file (or a file
 * without the key) yields `undefined`; anything else wrong with it fails
 * rather than falling back, so a typo can't silently point nisi at the
 * default data dir. The Rust side (`apps/desktop/src-tauri/src/data_dir.rs`)
 * implements the same rules — change both together.
 */
export const readConfigFileDataDir = (configPath: string, home: string) =>
	Effect.gen(function* () {
		let contents: string;
		try {
			contents = readFileSync(configPath, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			return yield* failConfig(`could not read ${configPath}: ${error}`, error);
		}

		let parsed: unknown;
		try {
			parsed = Bun.TOML.parse(contents);
		} catch (error) {
			return yield* failConfig(
				`${configPath} is not valid TOML: ${error}`,
				error,
			);
		}
		const table = parsed as Record<string, unknown>;

		for (const key of Object.keys(table)) {
			if (key !== configFileDataDirKey)
				return yield* failConfig(`${configPath} has an unknown key "${key}"`);
		}
		const value = table[configFileDataDirKey];
		if (value === undefined) return undefined;
		if (typeof value !== "string")
			return yield* failConfig(`${configPath}: data_dir must be a string`);

		const expanded = value.startsWith("~/")
			? join(home, value.slice(2))
			: value;
		if (!isAbsolute(expanded))
			return yield* failConfig(
				`${configPath}: data_dir must be an absolute path (or start with ~/), got "${value}"`,
			);
		return expanded;
	});

const defaultDataDir = () =>
	join(homedir(), "Library", "Application Support", "com.nisi.desktop");

/**
 * The app data dir every SQLite-backed package and the sidecar's own
 * handshake file share: `NISI_DATA_DIR`, else `data_dir` in
 * `~/.config/nisi/config.toml`, else
 * `~/Library/Application Support/com.nisi.desktop`. The config file is only
 * read when the env var is unset.
 */
export const getDataDirConfig = () =>
	Config.string("NISI_DATA_DIR").pipe(
		Config.orElse(() =>
			Config.succeed(getConfigFilePath()).pipe(
				Config.mapOrFail((configPath) =>
					readConfigFileDataDir(configPath, homedir()).pipe(
						Effect.map((dataDir) => dataDir ?? defaultDataDir()),
					),
				),
			),
		),
	);

/**
 * The one SQLite file every domain package's tables live in. Domain packages
 * generate their own migrations against their own schema, but they're all
 * applied to this same connection at boot — see this package's AGENTS.md for
 * why there's one file instead of one per domain.
 */
export const getAppDbPath = (dataDir: string): string =>
	join(dataDir, "app.db");
