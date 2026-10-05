import type { OpenSessionTarget } from "@repo/sidecar-api";
import { Console, Effect, Option } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { parseBaseArgument } from "./base-argument.ts";
import { zshCompletionScript } from "./completion.ts";

export const runCommand = <E, R>(
	run: (
		path: Option.Option<string>,
		target: OpenSessionTarget,
	) => Effect.Effect<void, E, R>,
	fail: Effect.Effect<never, E>,
) => {
	const pathArgument = Argument.string("path").pipe(Argument.optional);
	const pr = Command.make("pr", { path: pathArgument }, (options) =>
		run(options.path, { kind: "pr" }),
	).pipe(
		Command.withDescription(
			"Require an open PR for the current branch and open it in Nisi — errors if there is none.",
		),
	);
	const diff = Command.make(
		"diff",
		{
			base: Argument.string("base").pipe(Argument.optional),
			path: pathArgument,
		},
		(options) => {
			if (Option.isNone(options.base))
				return run(options.path, { kind: "branch" });
			const parsed = parseBaseArgument(options.base.value);
			return run(options.path, {
				kind: "branch",
				baseRef: parsed.baseRef,
				...(parsed.headRef === undefined ? {} : { headRef: parsed.headRef }),
			});
		},
	).pipe(
		Command.withDescription(
			"Diff <base>...HEAD, ignoring any open PR even when one exists. <base> may also be a range — <base>..<head> or <base>...<head>, both meaning merge-base(<base>, <head>) to <head> here, not git's own two-dot/three-dot distinction. With no <base>, diffs against the repo's default branch.",
		),
	);
	const zsh = Command.make("zsh", {}, () =>
		Console.log(zshCompletionScript),
	).pipe(
		Command.withDescription(
			'Print the zsh completion script for nisi — eval it in your shell startup file: eval "$(nisi completion zsh)".',
		),
	);
	const completion = Command.make("completion", {}, () =>
		Console.error("Specify a shell: nisi completion zsh").pipe(
			Effect.andThen(fail),
		),
	).pipe(
		Command.withDescription("Print a shell completion script."),
		Command.withSubcommands([zsh]),
	);
	const nisi = Command.make("nisi", { path: pathArgument }, (options) =>
		run(options.path, { kind: "auto" }),
	).pipe(
		Command.withDescription(
			"Open the PR for the current directory in Nisi, or diff against the default branch when there is none. Set LOG_LEVEL=debug for a trace of every step (which sidecar.json was read, each POST attempt, app resolution); the sidecar itself keeps its own rotating log under NISI_DATA_DIR/logs/.",
		),
		Command.withSubcommands([pr, diff, completion]),
	);
	return Command.run(nisi, { version: "0.1.0" });
};
