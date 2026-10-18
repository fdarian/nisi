import { resolve } from "node:path";
import { Effect, Stream } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { GitCommandError, PushTargetUnresolvable } from "./errors.ts";
import { git, gitStream } from "./exec.ts";
import { pathExistsOnDisk, resolvePushTarget } from "./repo.ts";

export type PushFailureReason = "rejected" | "rebase-conflict" | "other";

/** What {@link pushBranch} streams. Always ends with `done` or `failed`. */
export type PushEvent =
	| { readonly type: "step"; readonly command: string }
	| { readonly type: "line"; readonly text: string }
	| { readonly type: "done" }
	| {
			readonly type: "failed";
			readonly reason: PushFailureReason;
			readonly message: string;
	  };

type StepFinished = {
	readonly type: "finished";
	readonly exitCode: number;
	readonly output: ReadonlyArray<string>;
};

type PushError = GitCommandError | PushTargetUnresolvable;
type PushStream<A> = Stream.Stream<
	A,
	PushError,
	ChildProcessSpawner.ChildProcessSpawner
>;

const failed = (reason: PushFailureReason, message: string): PushEvent => ({
	type: "failed",
	reason,
	message,
});

type StepOutput = PushEvent | StepFinished;

/** Emits the `step` and `line` events of one git command, then a {@link StepFinished} for the caller to branch on. */
const runStep = (
	repoRoot: string,
	args: ReadonlyArray<string>,
): PushStream<StepOutput> => {
	const announce: StepOutput = {
		type: "step",
		command: `git ${args.join(" ")}`,
	};
	const output = gitStream(repoRoot, args).pipe(
		Stream.mapAccum(
			(): ReadonlyArray<string> => [],
			(
				lines,
				item,
			): readonly [ReadonlyArray<string>, ReadonlyArray<StepOutput>] =>
				item.type === "line"
					? [[...lines, item.text], [{ type: "line", text: item.text }]]
					: [
							lines,
							[{ type: "finished", exitCode: item.exitCode, output: lines }],
						],
		),
	);
	return Stream.concat(Stream.succeed(announce), output);
};

const afterStep = (
	step: PushStream<StepOutput>,
	next: (finished: StepFinished) => PushStream<PushEvent>,
): PushStream<PushEvent> =>
	step.pipe(
		Stream.flatMap((item) =>
			item.type === "finished" ? next(item) : Stream.succeed(item),
		),
	);

const describeFailure = (command: string, finished: StepFinished): string =>
	finished.output.filter((line) => line.trim() !== "").at(-1) ??
	`${command} exited with code ${finished.exitCode}`;

const isRejection = (output: ReadonlyArray<string>): boolean =>
	output.some(
		(line) =>
			line.includes("[rejected]") &&
			(line.includes("non-fast-forward") || line.includes("fetch first")),
	);

const rebaseInProgress = (repoRoot: string) =>
	Effect.gen(function* () {
		for (const name of ["rebase-merge", "rebase-apply"]) {
			const path = (yield* git(repoRoot, [
				"rev-parse",
				"--git-path",
				name,
			])).trim();
			if (yield* pathExistsOnDisk(resolve(repoRoot, path))) return true;
		}
		return false;
	});

const abortRebase = (repoRoot: string): PushStream<PushEvent> =>
	afterStep(runStep(repoRoot, ["rebase", "--abort"]), (aborted) =>
		Stream.succeed(
			aborted.exitCode === 0
				? failed(
						"rebase-conflict",
						"The rebase hit conflicts and was aborted; your worktree is unchanged.",
					)
				: failed(
						"other",
						`The rebase hit conflicts and "git rebase --abort" failed, so it is still in progress: ${describeFailure("git rebase --abort", aborted)}`,
					),
		),
	);

const pushStep = (
	repoRoot: string,
	remote: string,
	branch: string,
): PushStream<PushEvent> =>
	afterStep(
		runStep(repoRoot, ["push", "--progress", remote, `HEAD:${branch}`]),
		(pushed) => {
			if (pushed.exitCode === 0) return Stream.make({ type: "done" } as const);
			return Stream.succeed(
				isRejection(pushed.output)
					? failed(
							"rejected",
							`${remote}/${branch} has commits your branch doesn't; pull them before pushing.`,
						)
					: failed("other", describeFailure("git push", pushed)),
			);
		},
	);

const pullRebaseStep = (
	repoRoot: string,
	remote: string,
	branch: string,
): PushStream<PushEvent> =>
	afterStep(
		runStep(repoRoot, ["pull", "--rebase", "--autostash", remote, branch]),
		(pulled) => {
			if (pulled.exitCode === 0) return pushStep(repoRoot, remote, branch);
			return Stream.unwrap(
				rebaseInProgress(repoRoot).pipe(
					Effect.map((inProgress) =>
						inProgress
							? abortRebase(repoRoot)
							: Stream.succeed(
									failed("other", describeFailure("git pull", pulled)),
								),
					),
				),
			);
		},
	);

/**
 * Pushes the current branch to its upstream (see {@link resolvePushTarget}),
 * optionally rebasing onto the remote branch first. Never fails: a git
 * failure, an unresolvable target and a spawn error all end the stream with
 * a `failed` event, so a consumer always gets a terminal event. A rebase that
 * stops on conflicts is aborted before `rebase-conflict` is reported, so the
 * worktree is left as it was.
 */
export const pushBranch = (
	repoRoot: string,
	options: { readonly rebase: boolean },
): Stream.Stream<PushEvent, never, ChildProcessSpawner.ChildProcessSpawner> =>
	Stream.unwrap(
		resolvePushTarget(repoRoot).pipe(
			Effect.map((target) =>
				options.rebase
					? pullRebaseStep(repoRoot, target.remote, target.branch)
					: pushStep(repoRoot, target.remote, target.branch),
			),
		),
	).pipe(
		Stream.catch((error) =>
			Stream.make(
				failed(
					"other",
					error._tag === "PushTargetUnresolvable"
						? error.reason
						: `${error.command} could not be run: ${error.stderr || String(error.cause)}`,
				),
			),
		),
	);
