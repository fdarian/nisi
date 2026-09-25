import { BunServices } from "@effect/platform-bun";
import { Layer, Stream } from "effect";
import { GhGitHub } from "../../src/github/gh/github.ts";
import { PullRequestAttention } from "../../src/github/gh/attention.ts";

export const GitHubTestLayer = GhGitHub.layer.pipe(
	Layer.provideMerge(
		Layer.succeed(PullRequestAttention, {
			changes: () => Stream.succeed({ watched: false, awaitingNewCi: false }),
		}),
	),
	Layer.provideMerge(BunServices.layer),
);
