import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./errors.ts";

type ProcessResult = {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
};

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
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const command_ = ChildProcess.make(command, args, {
				cwd,
				...(input === undefined
					? {}
					: { stdin: Stream.succeed(new TextEncoder().encode(input)) }),
			});
			const handle = yield* spawner
				.spawn(command_)
				.pipe(
					Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
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
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const command_ = ChildProcess.make(command, args, {
				cwd,
				...(input === undefined
					? {}
					: { stdin: Stream.succeed(new TextEncoder().encode(input)) }),
			});
			const handle = yield* spawner
				.spawn(command_)
				.pipe(
					Effect.mapError((cause) => spawnFailure(command, args, cwd, cause)),
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

export const git = (cwd: string, args: ReadonlyArray<string>, input?: string) =>
	runText(cwd, "git", args, input);

export const gitResult = (
	cwd: string,
	args: ReadonlyArray<string>,
	input?: string,
) => runResult(cwd, "git", args, input);

export const gitBytes = (
	cwd: string,
	args: ReadonlyArray<string>,
	input?: string,
) => runBytes(cwd, "git", args, input);

export const gh = (cwd: string, args: ReadonlyArray<string>) =>
	runText(cwd, "gh", args);

export const ghResult = (cwd: string, args: ReadonlyArray<string>) =>
	runResult(cwd, "gh", args);
