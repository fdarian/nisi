import { getDataDirConfig, getGuidesDir } from "@repo/db/paths";
import {
	checkoutGuideFolder,
	GhGitHub,
	type GitCommandError,
	type GuideFolderUnresolvable,
	PullRequestAttention,
	type PullRequestStatesError,
} from "@repo/git";
import { type Config, Console, Effect, Layer, Stream } from "effect";

/** Nothing in the CLI watches a PR, so the check watchers `GhGitHub` builds never run. */
const GitHubForCli = GhGitHub.layer.pipe(
	Layer.provide(
		Layer.succeed(PullRequestAttention, { changes: () => Stream.empty }),
	),
);

const describeFailure = (
	error:
		| GuideFolderUnresolvable
		| Config.ConfigError
		| GitCommandError
		| PullRequestStatesError,
): string => {
	switch (error._tag) {
		case "GuideFolderUnresolvable":
			return error.message;
		case "ConfigError":
			return `could not read the nisi data directory setting: ${error.message}`;
		case "GitCommandError":
			return `${error.command} ${error.args.join(" ")} failed${error.exitCode === null ? " to start" : ""}: ${error.stderr.trim() || String(error.cause)}`;
		case "GhNotAuthenticated":
		case "GhRateLimited":
			return `could not ask GitHub which PR this checkout belongs to: ${error.reason}`;
		case "GitHubUnreachable":
			return `could not reach GitHub to find which PR this checkout belongs to: ${error.reason}`;
		case "GhOutputDecodeError":
			return `could not read gh's answer to \`${error.command}\``;
	}
};

/**
 * Where this checkout's guide lives (see `checkoutGuideFolder`). Whatever
 * stops it, such as a detached `HEAD` with no single open PR or a GitHub
 * lookup that fails, is printed as its own message and fails the command:
 * the CLI runs with error reporting off, so an unprinted failure would exit
 * non-zero in silence.
 */
export const guideFolderOf = <E>(
	repoRoot: string,
	fail: Effect.Effect<never, E>,
) =>
	Effect.gen(function* () {
		const dataDir = yield* getDataDirConfig();
		return yield* checkoutGuideFolder(getGuidesDir(dataDir), repoRoot);
	}).pipe(
		Effect.provide(GitHubForCli),
		Effect.catch((error) =>
			Console.error(describeFailure(error)).pipe(Effect.andThen(fail)),
		),
	);
