import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { GitHub } from "@repo/git";
import { Context, Effect, Layer } from "effect";
import { GitHubLive } from "../github-live.ts";
import { AttentionState } from "../pull-request-attention.ts";

type Client = {
	github: Context.Service.Shape<typeof GitHub>;
	attention: Context.Service.Shape<typeof AttentionState>;
};
class First extends Context.Service<First, Client>()("test/FirstGitHub") {}
class Second extends Context.Service<Second, Client>()("test/SecondGitHub") {}

test("the shared GitHub layer exposes the same client and attention state to both consumers", async () => {
	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const consume = Effect.gen(function* () {
					return { github: yield* GitHub, attention: yield* AttentionState };
				});
				yield* Effect.gen(function* () {
					const first = yield* First;
					const second = yield* Second;
					expect(first.github).toBe(second.github);
					expect(first.attention).toBe(second.attention);
				}).pipe(
					Effect.provide(
						Layer.mergeAll(
							Layer.effect(First, consume).pipe(Layer.provideMerge(GitHubLive)),
							Layer.effect(Second, consume).pipe(
								Layer.provideMerge(GitHubLive),
							),
						),
					),
				);
			}),
		).pipe(Effect.provide(BunServices.layer)),
	);
});
