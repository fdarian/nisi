import { Context, type Stream } from "effect";

export type PullRequestIdentity = {
	readonly owner: string;
	readonly repo: string;
	readonly number: number;
};

export type Attention = {
	readonly watched: boolean;
	readonly awaitingNewCi: boolean;
};

export class PullRequestAttention extends Context.Service<
	PullRequestAttention,
	{ readonly changes: (pr: PullRequestIdentity) => Stream.Stream<Attention> }
>()("git/github/gh/attention") {}
