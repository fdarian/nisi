#!/usr/bin/env bun
import path from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { resolveRepoRoot } from "@repo/git";
import { MinimumLogLevelLayer } from "@repo/logging";
import type { OpenSessionTarget } from "@repo/sidecar-api";
import { Console, Effect, Logger, Option, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { parseBaseArgument } from "./base-argument.ts";
import { handoff, logFilePathConfig } from "./handoff.ts";

/** Already printed a message for the user — `BunRuntime.runMain` just needs to see a failure to exit non-zero. */
class ReportedFailure extends Schema.TaggedErrorClass<ReportedFailure>()(
	"ReportedFailure",
	{},
) {}

const fail = Effect.fail(new ReportedFailure());

/**
 * All console logging routes to stderr, at every level — stdout is reserved
 * for the one line of human-facing output each outcome below prints via
 * `Console.log`/`Console.error` (still stdout for the success case, since
 * that's the CLI's actual "result"). `LOG_LEVEL=debug nisi` then only adds
 * lines on stderr, never changes what a script piping stdout would see.
 */
const LoggerLive = Logger.layer([Logger.withConsoleError(Logger.formatLogFmt)]);

/** Every subcommand's own optional positional — resolves the same way `nisi <path>` always has. */
const pathArgument = Argument.string("path").pipe(Argument.optional);

/**
 * Shared by `nisi`/`nisi pr`/`nisi diff` — they differ only in which
 * `target` they resolve to (`"auto"`/`"pr"`/`"branch"`), not in how a
 * resolved repo root gets handed off or how the outcome gets reported.
 */
const run = (pathArg: Option.Option<string>, target: OpenSessionTarget) =>
	Effect.gen(function* () {
		const cwd = path.resolve(Option.getOrElse(pathArg, () => process.cwd()));
		const logFilePath = yield* logFilePathConfig.pipe(Effect.orDie);

		const repoRoot = yield* resolveRepoRoot(cwd).pipe(
			Effect.catchTag("NotAGitRepository", () =>
				Console.error(`${cwd} is not inside a git repository.`).pipe(
					Effect.andThen(fail),
				),
			),
		);

		const outcome = yield* handoff(repoRoot, target);

		switch (outcome._tag) {
			case "opened": {
				const sessionTarget = outcome.session.target;
				if (sessionTarget.kind === "branch") {
					return yield* Console.log(
						`Opened Nisi — diffing ${sessionTarget.baseRef}...${sessionTarget.headRef}.`,
					);
				}
				return yield* Console.log(
					`Opened PR #${sessionTarget.number} — ${sessionTarget.title} (${sessionTarget.owner}/${sessionTarget.repo}) in Nisi.`,
				);
			}
			case "rejected": {
				yield* Console.error(`Nisi rejected the request: ${outcome.message}`);
				return yield* fail;
			}
			case "launchFailed": {
				yield* Console.error(`Could not start Nisi: ${outcome.reason}`);
				yield* Console.error(`Sidecar log: ${logFilePath}`);
				return yield* fail;
			}
			case "unreachable": {
				yield* Console.error(
					"Timed out waiting for Nisi to start — it may still be booting. Try again in a moment.",
				);
				yield* Console.error(
					`Re-run with LOG_LEVEL=debug for details, or check the sidecar log: ${logFilePath}`,
				);
				return yield* fail;
			}
			case "unresponsive": {
				yield* Console.error(
					"Nisi is running but didn't respond in time. Try again in a moment.",
				);
				yield* Console.error(
					`Re-run with LOG_LEVEL=debug for details, or check the sidecar log: ${logFilePath}`,
				);
				return yield* fail;
			}
		}
	});

const pr = Command.make("pr", { path: pathArgument }, ({ path: pathArg }) =>
	run(pathArg, { kind: "pr" }),
).pipe(
	Command.withDescription(
		"Require an open PR for the current branch and open it in Nisi — errors if there is none.",
	),
);

const diff = Command.make(
	"diff",
	{ base: Argument.string("base").pipe(Argument.optional), path: pathArgument },
	({ base, path: pathArg }) => {
		if (Option.isNone(base)) return run(pathArg, { kind: "branch" });

		const parsed = parseBaseArgument(base.value);
		return run(pathArg, {
			kind: "branch",
			baseRef: parsed.baseRef,
			...(parsed.headRef === undefined ? {} : { headRef: parsed.headRef }),
		});
	},
).pipe(
	Command.withDescription(
		"Diff <base>...HEAD, ignoring any open PR even when one exists. <base> may also be a " +
			"range — <base>..<head> or <base>...<head>, both meaning merge-base(<base>, <head>) " +
			"to <head> here, not git's own two-dot/three-dot distinction. With no <base>, diffs " +
			"against the repo's default branch.",
	),
);

const nisi = Command.make("nisi", { path: pathArgument }, ({ path: pathArg }) =>
	run(pathArg, { kind: "auto" }),
).pipe(
	Command.withDescription(
		"Open the PR for the current directory in Nisi, or diff against the default branch when " +
			"there is none. Set LOG_LEVEL=debug for a trace of every step (which sidecar.json was " +
			"read, each POST attempt, app resolution); the sidecar itself keeps its own rotating " +
			"log under NISI_DATA_DIR/logs/.",
	),
	Command.withSubcommands([pr, diff]),
);

BunRuntime.runMain(
	Command.run(nisi, { version: "0.1.0" }).pipe(
		Effect.provide(LoggerLive),
		Effect.provide(MinimumLogLevelLayer),
		Effect.provide(BunServices.layer),
	),
	{ disableErrorReporting: true },
);
