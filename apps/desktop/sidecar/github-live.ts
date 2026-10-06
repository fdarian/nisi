import { GhGitHub } from "@repo/git";
import { Layer } from "effect";
import { PullRequestAttentionLive } from "./pull-request-attention.ts";

export const GitHubLive = GhGitHub.layer.pipe(
	Layer.provideMerge(PullRequestAttentionLive.layer),
);
