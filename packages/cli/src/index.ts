#!/usr/bin/env bun
import path from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { resolveRepoRoot } from "@repo/git/repo";
import { MinimumLogLevelLayer } from "@repo/logging";
import type { OpenSessionTarget } from "@repo/sidecar-api";
import { Console, Effect, Logger, Option, Schema } from "effect";
import { handoff, logFilePathConfig } from "./handoff.ts";
import { LaunchTracingLive } from "./tracing.ts";

/** Already printed a message for the user — `BunRuntime.runMain` just needs to see a failure to exit non-zero. */
class ReportedFailure extends Schema.TaggedError<ReportedFailure>()(
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
			Effect.withSpan("cli.repo-root.resolve"),
			Effect.catchTag("NotAGitRepository", () =>
				Console.error(`${cwd} is not inside a git repository.`).pipe(
					Effect.andThen(fail),
				),
			),
		);

		const outcome = yield* handoff(repoRoot, target);
		yield* Effect.annotateCurrentSpan({ outcome: outcome._tag });

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
	}).pipe(Effect.withSpan("cli.main"));

const args = process.argv.slice(2);
const simple =
	args.length === 0 ||
	(args.length === 1 &&
		args[0] !== undefined &&
		!args[0].startsWith("-") &&
		!["pr", "diff", "debug", "guide", "completion"].includes(args[0]));
const program = simple
	? run(Option.fromUndefinedOr(args[0]), { kind: "auto" })
	: Effect.gen(function* () {
			const commands = yield* Effect.promise(() => import("./commands.ts"));
			return yield* commands.runCommand(run, fail);
		});

BunRuntime.runMain(
	program.pipe(
		Effect.withSpan("cli.process", { root: true }),
		Effect.provide(LaunchTracingLive),
		Effect.provide(LoggerLive),
		Effect.provide(MinimumLogLevelLayer),
		Effect.provide(BunServices.layer),
	),
	{ disableErrorReporting: true },
);
