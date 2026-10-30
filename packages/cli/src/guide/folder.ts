import { getDataDirConfig, getGuidesDir } from "@repo/db/paths";
import { checkoutGuideFolder, GhGitHub, PullRequestAttention } from "@repo/git";
import { Console, Effect, Layer, Stream } from "effect";

/** Nothing in the CLI watches a PR, so the check watchers `GhGitHub` builds never run. */
const GitHubForCli = GhGitHub.layer.pipe(
	Layer.provide(
		Layer.succeed(PullRequestAttention, { changes: () => Stream.empty }),
	),
);

/**
 * Where this checkout's guide lives (see `checkoutGuideFolder`). An
 * unresolvable folder, such as a detached `HEAD` with no single open PR, is
 * printed as its own message and fails the command.
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
		Effect.catchTag("GuideFolderUnresolvable", (unresolvable) =>
			Console.error(unresolvable.message).pipe(Effect.andThen(fail)),
		),
	);
