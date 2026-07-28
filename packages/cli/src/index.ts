#!/usr/bin/env bun
import path from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { resolveRepoRoot } from "@repo/git";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { handoff } from "./handoff.ts";

/** Already printed a message for the user — `BunRuntime.runMain` just needs to see a failure to exit non-zero. */
class ReportedFailure extends Schema.TaggedErrorClass<ReportedFailure>()(
	"ReportedFailure",
	{},
) {}

const fail = Effect.fail(new ReportedFailure());

const nisi = Command.make(
	"nisi",
	{ path: Argument.string("path").pipe(Argument.optional) },
	({ path: pathArg }) =>
		Effect.gen(function* () {
			const cwd = path.resolve(Option.getOrElse(pathArg, () => process.cwd()));

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
					return yield* fail;
				}
				case "unreachable": {
					yield* Console.error(
						"Timed out waiting for Nisi to start — it may still be booting. Try again in a moment.",
					);
					return yield* fail;
				}
			}
		}),
).pipe(
	Command.withDescription(
		"Detect the PR for the current directory and open it in Nisi.",
	),
);

BunRuntime.runMain(
	Command.run(nisi, { version: "0.1.0" }).pipe(
		Effect.provide(BunServices.layer),
	),
	{ disableErrorReporting: true },
);
