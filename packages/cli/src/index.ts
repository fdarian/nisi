#!/usr/bin/env bun
import path from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { resolveRepoRoot } from "@repo/git";
import { MinimumLogLevelLayer } from "@repo/logging";
import { Console, Effect, Logger, Option, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
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

const nisi = Command.make(
	"nisi",
	{ path: Argument.string("path").pipe(Argument.optional) },
	({ path: pathArg }) =>
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

			const outcome = yield* handoff(repoRoot);

			switch (outcome._tag) {
				case "opened": {
					const { pr } = outcome.session;
					if (pr === null) {
						return yield* Console.log(
							"No open pull request for this branch — opened Nisi against the repo's default branch.",
						);
					}
					return yield* Console.log(
						`Opened PR #${pr.number} — ${pr.title} (${pr.owner}/${pr.repo}) in Nisi.`,
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
		}),
).pipe(
	Command.withDescription(
		"Detect the PR for the current directory and open it in Nisi. Set LOG_LEVEL=debug " +
			"for a trace of every step (which sidecar.json was read, each POST attempt, app " +
			"resolution); the sidecar itself keeps its own rotating log under NISI_DATA_DIR/logs/.",
	),
);

BunRuntime.runMain(
	Command.run(nisi, { version: "0.1.0" }).pipe(
		Effect.provide(LoggerLive),
		Effect.provide(MinimumLogLevelLayer),
		Effect.provide(BunServices.layer),
	),
	{ disableErrorReporting: true },
);
