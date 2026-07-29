import { Config, Effect, Layer, LogLevel, References } from "effect";

const isLogLevel = (value: string): value is LogLevel.LogLevel =>
	(LogLevel.values as ReadonlyArray<string>).includes(value);

/** `"debug"` / `"DEBUG"` / `"Debug"` all resolve to the `LogLevel` spelling Effect itself uses. */
const normalize = (raw: string): string =>
	raw.trim().length === 0
		? raw
		: raw.trim()[0]?.toUpperCase() + raw.trim().slice(1).toLowerCase();

/**
 * `LOG_LEVEL` env var, case-insensitive, defaulting to `"Info"` — read by
 * both the sidecar and the CLI so one `LOG_LEVEL=debug nisi` controls
 * verbosity end to end. An unrecognized value (typo'd level name) also
 * falls back to `"Info"` rather than crashing the process over a logging
 * knob — `Config.withDefault` already establishes that "missing" isn't a
 * hard failure here, so "present but unrecognized" is treated the same way.
 */
export const minimumLogLevelConfig: Config.Config<LogLevel.LogLevel> =
	Config.string("LOG_LEVEL").pipe(
		Config.withDefault("Info"),
		Config.map((raw) => {
			const candidate = normalize(raw);
			return isLogLevel(candidate) ? candidate : "Info";
		}),
	);

/** Installs `minimumLogLevelConfig`'s result as the fiber's `MinimumLogLevel` reference. */
export const MinimumLogLevelLayer: Layer.Layer<never> = Layer.effect(
	References.MinimumLogLevel,
	minimumLogLevelConfig.pipe(Effect.orDie),
);
