import { dirname } from "node:path";
import { Duration, Effect, Logger, type Scope } from "effect";
import { FileSystem } from "effect/FileSystem";

/** Default cap on the live log file — past this, the file rotates rather than growing forever. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Moves `path` to `path.1` (overwriting whatever was there) once it's grown
 * past `maxBytes`, so the sidecar's log file is bounded at roughly
 * `2 * maxBytes` for the life of the process instead of growing without
 * limit. A missing file (nothing written yet) isn't an error — there's
 * nothing to rotate.
 */
const rotateIfNeeded = (
	fs: FileSystem,
	path: string,
	maxBytes: number,
): Effect.Effect<void> =>
	fs.stat(path).pipe(
		Effect.flatMap((info) =>
			Number(info.size) < maxBytes
				? Effect.void
				: fs
						.remove(`${path}.1`, { force: true })
						.pipe(Effect.andThen(fs.rename(path, `${path}.1`))),
		),
		Effect.catch(() => Effect.void),
	);

/**
 * A `Logger` that appends formatted lines to `path`, rotating once the file
 * passes `maxBytes` (one `.1` backup kept, no unbounded growth) — the
 * sidecar's answer to "stdout goes nowhere in production." Batches writes
 * every `batchWindow` (default 1s, same as `Logger.toFile`'s own default)
 * rather than opening the file per log line.
 *
 * Reopens (`flag: "a"`) and closes the file on every flush instead of
 * holding one file descriptor for the process lifetime — the simplest way
 * to make rotation (a rename out from under the path) actually take effect
 * on the *next* write, which a long-lived fd wouldn't see.
 */
export const rotatingFileLogger = (
	path: string,
	options?: {
		readonly maxBytes?: number;
		readonly batchWindow?: Duration.Input;
	},
): Effect.Effect<
	Logger.Logger<unknown, void>,
	never,
	FileSystem | Scope.Scope
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		yield* fs
			.makeDirectory(dirname(path), { recursive: true })
			.pipe(Effect.ignore);
		const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

		return yield* Logger.formatLogFmt.pipe(
			Logger.batched({
				window: options?.batchWindow ?? Duration.seconds(1),
				flush: (lines) =>
					rotateIfNeeded(fs, path, maxBytes).pipe(
						Effect.andThen(
							fs.writeFileString(path, `${lines.join("\n")}\n`, {
								flag: "a",
							}),
						),
						Effect.catch((cause: unknown) =>
							Effect.sync(() =>
								console.error(`[logging] failed to write ${path}:`, cause),
							),
						),
					),
			}),
		);
	});
