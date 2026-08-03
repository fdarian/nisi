import { resolveBin } from "@repo/bin-resolver";
import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./errors.ts";

type ProcessResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

/** What {@link ghResult} (and {@link gitResult}) resolve to — exported so callers that branch on a lenient result's `exitCode`/`stderr` (rather than just piping it into a decoder) can name the type. */
export type GhResult = ProcessResult;

/**
 * Every `git`/`gh` invocation goes through this — the one place that's
 * bitten us before (a bare `"gh"` silently failing to spawn under a GUI
 * app's minimal `PATH`, see `resolveBin` above) and the one place worth
 * logging every spawn from, rather than scattering `Effect.log` across each
 * caller. Debug level: a single `sessions.open` alone shells out several of
 * these, so this would flood `Info` output.
 */
const logSpawnStart = (command: string, args: ReadonlyArray<string>) =>
	Effect.logDebug("spawning process", { command, args });

const logSpawnFailure = (
	command: string,
	args: ReadonlyArray<string>,
	durationMs: number,
	cause: unknown,
) =>
	Effect.logWarning("process failed to spawn", {
		command,
		args,
		durationMs,
		cause,
	});

const logSpawnDone = (
	command: string,
	args: ReadonlyArray<string>,
	durationMs: number,
	exitCode: number,
) => Effect.logDebug("process exited", { command, args, durationMs, exitCode });

const spawnFailure = (
	command: string,
	args: ReadonlyArray<string>,
	cwd: string,
	cause: unknown,
) =>
	new GitCommandError({
		command,
		args,
		cwd,
		exitCode: null,
		stderr: "",
		cause,
	});

/**
 * Runs a command to completion and reports its exit code rather than failing
 * on a non-zero one — for callers where "the command ran and said no" (e.g.
 * `gh pr view` with no PR) is an expected outcome, not an error.
 */
const runResult = (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>,
	input?: string,
): Effect.Effect<
	ProcessResult,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const startedAt = Date.now();
			yield* logSpawnStart(command, args);

			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const command_ = ChildProcess.make(command, args, {
				cwd,
				...(input === undefined
					? {}
					: { stdin: Stream.succeed(new TextEncoder().encode(input)) }),
			});
			const handle = yield* spawner.spawn(command_).pipe(
				Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
				Effect.tapError((error) =>
					logSpawnFailure(command, args, Date.now() - startedAt, error.cause),
				),
			);

			const [stdout, stderr, exitCode] = yield* Effect.all(
				[
					Stream.decodeText(handle.stdout).pipe(Stream.mkString),
					Stream.decodeText(handle.stderr).pipe(Stream.mkString),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			).pipe(
				Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
			);

			yield* logSpawnDone(command, args, Date.now() - startedAt, exitCode);
			return { stdout, stderr, exitCode };
		}),
	);

/** Same as {@link runResult}, but fails when the command exits non-zero. */
export const runText = (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>,
	input?: string,
): Effect.Effect<
	string,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	runResult(cwd, command, args, input).pipe(
		Effect.flatMap((result) =>
			result.exitCode === 0
				? Effect.succeed(result.stdout)
				: Effect.fail(
						new GitCommandError({
							command,
							args,
							cwd,
							exitCode: result.exitCode,
							stderr: result.stderr,
							cause: new Error(
								`${command} ${args.join(" ")} exited with code ${result.exitCode}: ${result.stderr}`,
							),
						}),
					),
		),
	);

/** Raw stdout bytes — for `cat-file --batch`, whose payload isn't guaranteed to be valid UTF-8. */
export const runBytes = (
	cwd: string,
	command: string,
	args: ReadonlyArray<string>,
	input?: string,
): Effect.Effect<
	Buffer,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.scoped(
		Effect.gen(function* () {
			const startedAt = Date.now();
			yield* logSpawnStart(command, args);

			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const command_ = ChildProcess.make(command, args, {
				cwd,
				...(input === undefined
					? {}
					: { stdin: Stream.succeed(new TextEncoder().encode(input)) }),
			});
			const handle = yield* spawner.spawn(command_).pipe(
				Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
				Effect.tapError((error) =>
					logSpawnFailure(command, args, Date.now() - startedAt, error.cause),
				),
			);

			const [chunks, stderr, exitCode] = yield* Effect.all(
				[
					Stream.runCollect(handle.stdout),
					Stream.decodeText(handle.stderr).pipe(Stream.mkString),
					handle.exitCode,
				],
				{ concurrency: "unbounded" },
			).pipe(
				Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
			);

			yield* logSpawnDone(command, args, Date.now() - startedAt, exitCode);

			if (exitCode !== 0) {
				return yield* new GitCommandError({
					command,
					args,
					cwd,
					exitCode,
					stderr,
					cause: new Error(
						`${command} ${args.join(" ")} exited with code ${exitCode}: ${stderr}`,
					),
				});
			}

			return Buffer.concat(chunks);
		}),
	);

/**
 * Resolved once per process rather than per call — `resolveBin` only reads
 * `PATH`/`process.env` and the filesystem, neither of which changes over the
 * sidecar's lifetime, so there's no correctness reason to repeat the lookup
 * on every `git`/`gh` invocation.
 *
 * Both go through `@repo/bin-resolver` rather than the bare command name for
 * the same reason as `sidecar/walkthrough/model-discovery.ts`'s harness
 * CLIs: a macOS `.app` launched from Finder/`open` inherits a minimal `PATH`
 * (no login shell startup files ever run), so a bare `"gh"` — commonly
 * installed via Homebrew at `/opt/homebrew/bin`, not on that minimal `PATH`
 * — would silently fail to spawn in the built app even though it resolves
 * fine from an interactive dev shell. `git` itself usually still resolves
 * (Apple ships one at `/usr/bin/git`, which *is* on the minimal `PATH`), but
 * a Homebrew-installed `git` takes the same exposure, so it's resolved the
 * same way for consistency rather than as a special case.
 */
const GIT_BIN = resolveBin("git", "NISI_GIT_BIN");
const GH_BIN = resolveBin("gh", "NISI_GH_BIN");

export const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
	runText(cwd, GIT_BIN, args, input);

export const gitResult = (
	cwd: string,
	args: ReadonlyArray<string>,
	input?: string,
) => runResult(cwd, GIT_BIN, args, input);

export const gitBytes = (
	cwd: string,
	args: ReadonlyArray<string>,
	input?: string,
) => runBytes(cwd, GIT_BIN, args, input);

export const gh = (cwd: string, args: ReadonlyArray<string>) =>
	runText(cwd, GH_BIN, args);

export const ghResult = (cwd: string, args: ReadonlyArray<string>) =>
	runResult(cwd, GH_BIN, args);
