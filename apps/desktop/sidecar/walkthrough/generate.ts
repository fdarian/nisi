import { basename, dirname } from "node:path";
import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createLocalSandbox } from "@repo/harness-local";
import type {
	GenerateEvent,
	HarnessId,
	StoredWalkthrough,
} from "@repo/sidecar-api";
import {
	buildDigest,
	buildSystemPrompt,
	createBuffer,
	createWalkthroughTools,
	defaultDigestBudget,
	evaluateWalkthrough,
	renderDigest,
} from "@repo/walkthrough";
import type { Context } from "effect";
import { Effect, Result } from "effect";
import type { AppServices } from "../services.ts";
import { type GenerationContext, gatherGenerationContext } from "./context.ts";
import {
	beginGeneration,
	clearGeneration,
	recordGenerationEvent,
} from "./generation-log.ts";
import { createHarnessAdapter } from "./harnesses.ts";
import {
	getLiveSession,
	type LiveWalkthroughSession,
	setLiveSession,
	stopLiveSession,
} from "./live-sessions.ts";
import { type StoredWalkthroughRecord, WalkthroughStore } from "./store.ts";

/** Bounded write → validate → feedback → edit loop — PLAN.md, Phase 3. Never infinite: an agent that can't converge fails loudly instead of burning turns forever. */
const MAX_TURNS = 4;

/** Thrown (not yielded) so `http.ts`'s handler can map it to the contract's declared `NOT_FOUND`, the same treatment `diff.files`/`diff.file` give an unknown session — everything else that can go wrong mid-generation yields an in-band `failed` event instead of tearing down the stream. */
export class GenerateSessionNotFound extends Error {
	constructor(readonly sessionId: string) {
		super(`session not found: ${sessionId}`);
	}
}

export type GenerateInput = {
	readonly sessionId: string;
	readonly harness: HarnessId;
	readonly model?: string | undefined;
};

const buildFreshPrompt = (
	digestText: string,
	priorContent: string | undefined,
): string =>
	priorContent === undefined
		? `Diff digest for this pull request:\n\n${digestText}`
		: [
				"This is a regeneration — the underlying sidecar process restarted since the walkthrough below was written, so the previous conversation is gone, but its result isn't. Use it as your starting point: keep what's still accurate, update what the current diff changed.",
				"",
				"Previous walkthrough (JSON):",
				"",
				priorContent,
				"",
				"Current diff digest:",
				"",
				digestText,
			].join("\n");

const buildContinuationPrompt = (digestText: string): string =>
	`The PR has changed since your last turn. Updated diff digest:\n\n${digestText}`;

const startFreshSession = async (
	input: GenerateInput,
	repoRoot: string,
): Promise<{
	readonly agent: LiveWalkthroughSession["agent"];
	readonly session: LiveWalkthroughSession["session"];
	readonly buffer: LiveWalkthroughSession["buffer"];
}> => {
	const buffer = createBuffer();
	const sandbox = createLocalSandbox({
		defaultWorkingDirectory: dirname(repoRoot),
	});
	const agent = new HarnessAgent({
		harness: createHarnessAdapter(input.harness, input.model),
		sandbox,
		sandboxConfig: { workDir: basename(repoRoot) },
		// Same key names (`write`/`edit`) as every adapter's own file-editing
		// builtins — user tools win on key collision, so this redirects the
		// model's usual editing tools at the walkthrough buffer instead of the
		// real worktree without needing per-adapter tool filtering.
		tools: createWalkthroughTools(buffer),
		instructions: buildSystemPrompt(),
	});
	const session = await agent.createSession();
	return { agent, session, buffer };
};

const runEffect = <A, E>(
	effect: Effect.Effect<A, E, AppServices>,
	mainContext: Context.Context<AppServices>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(mainContext)));

/**
 * Gathers context via `Effect.result` rather than letting a failure reject
 * the promise — unwrapping a rejected `Effect.runPromise`'s cause to find a
 * specific tagged error is exactly the kind of Effect-internals-poking this
 * sidesteps. `SessionNotFound` throws `GenerateSessionNotFound` (see above,
 * for `http.ts` to map to the contract's `NOT_FOUND`); every other failure
 * becomes an in-band `failed` event instead of tearing down the stream.
 */
const resolveContext = async (
	sessionId: string,
	mainContext: Context.Context<AppServices>,
): Promise<GenerationContext | undefined> => {
	const result = await runEffect(
		Effect.result(gatherGenerationContext(sessionId)),
		mainContext,
	);
	if (Result.isSuccess(result)) return result.success;
	if (result.failure._tag === "SessionNotFound") {
		throw new GenerateSessionNotFound(sessionId);
	}
	return undefined;
};

/**
 * The generation loop's implementation, streamed as `GenerateEvent`s through
 * the same `eventIterator` mechanism `events.subscribe` uses. Bridges Effect
 * (session/digest lookup, persistence) from plain async code (the harness
 * agent's own Promise-based API) at exactly two points — gathering context
 * up front, and persisting on success — rather than trying to run the whole
 * multi-turn loop inside one Effect.
 */
export async function* generateWalkthrough(
	input: GenerateInput,
	mainContext: Context.Context<AppServices>,
): AsyncGenerator<GenerateEvent> {
	const context = await resolveContext(input.sessionId, mainContext);
	if (context === undefined) {
		yield {
			type: "failed",
			message: "Could not read this session's diff — see the sidecar log.",
		};
		return;
	}

	const digestEntries = buildDigest(context.digestFiles, defaultDigestBudget);
	const digestText = renderDigest(digestEntries);

	const live = getLiveSession(input.sessionId);
	const reuseLive =
		live !== undefined &&
		live.harness === input.harness &&
		live.model === input.model;

	let agent: LiveWalkthroughSession["agent"];
	let session: LiveWalkthroughSession["session"];
	let buffer: LiveWalkthroughSession["buffer"];
	let turnPrompt: string;

	if (reuseLive) {
		({ agent, session, buffer } = live);
		turnPrompt = buildContinuationPrompt(digestText);
	} else {
		yield { type: "bootstrapping" };
		const prior = await runEffect(
			Effect.gen(function* () {
				const store = yield* WalkthroughStore;
				return yield* store.get(input.sessionId);
			}).pipe(Effect.orElseSucceed(() => null)),
			mainContext,
		);
		try {
			({ agent, session, buffer } = await startFreshSession(
				input,
				context.repoRoot,
			));
		} catch (error) {
			yield {
				type: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
			return;
		}
		turnPrompt = buildFreshPrompt(digestText, prior?.content);
	}

	// Tracked from the moment a session exists, not just on eventual success —
	// a regenerate that arrives while this turn loop is still retrying (or
	// after it ultimately fails validation) should still be able to continue
	// the same conversation rather than finding nothing.
	setLiveSession(input.sessionId, {
		harness: input.harness,
		model: input.model,
		agent,
		session,
		buffer,
	});

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		yield { type: "turn-started", turn };

		try {
			const result = await agent.stream({ session, prompt: turnPrompt });
			for await (const part of result.fullStream) {
				if (part.type === "tool-call") {
					yield { type: "tool-call", turn, toolName: part.toolName };
				}
			}
		} catch (error) {
			yield {
				type: "failed",
				message: error instanceof Error ? error.message : String(error),
			};
			await stopLiveSession(input.sessionId);
			return;
		}

		const evaluation = evaluateWalkthrough(
			buffer.content,
			context.changedFileFacts,
		);

		if (evaluation.status === "valid") {
			let record: StoredWalkthroughRecord;
			try {
				record = await runEffect(
					Effect.gen(function* () {
						const store = yield* WalkthroughStore;
						return yield* store.save({
							sessionId: input.sessionId,
							harness: input.harness,
							model: input.model ?? null,
							content: JSON.stringify(evaluation.walkthrough),
							fingerprints: context.fingerprints,
						});
					}),
					mainContext,
				);
			} catch (error) {
				yield {
					type: "failed",
					message: `Generated successfully, but saving it failed: ${error instanceof Error ? error.message : String(error)}`,
				};
				return;
			}

			const stored: StoredWalkthrough = {
				sessionId: record.sessionId,
				harness: record.harness,
				model: record.model,
				walkthrough: evaluation.walkthrough,
				fingerprints: record.fingerprints,
				generatedAt: record.generatedAt,
			};
			yield { type: "done", walkthrough: stored };
			return;
		}

		yield { type: "validation-failed", turn, feedback: evaluation.feedback };

		if (turn === MAX_TURNS) {
			yield {
				type: "failed",
				message: `Coverage/reference validation still failing after ${MAX_TURNS} turns.`,
			};
			await stopLiveSession(input.sessionId);
			return;
		}

		yield { type: "retrying", turn: turn + 1 };
		turnPrompt = evaluation.feedback;
	}
}

/**
 * Starts a generation and records every event it produces into
 * `generation-log.ts`'s retained log, so a `generate` request that reattaches
 * later (a tab switch, a dropped connection) sees the full history instead
 * of nothing — PLAN.md's "the sidecar is the source of truth for an
 * in-flight generation."
 *
 * Only the *first* event is awaited here — long enough to let
 * `GenerateSessionNotFound` (thrown from `generateWalkthrough`'s very first
 * step, before any yield) propagate to `http.ts`'s caller exactly as before,
 * so the NOT_FOUND contract is unchanged. Everything after that first event
 * runs detached, in the background, independent of whether this specific
 * caller stays connected — which is what lets the generation survive a tab
 * switch at all: `@ai-sdk/harness`'s "session already has a turn in
 * progress" guard only makes sense if the loop really does keep running
 * server-side once nobody's pulling it, and empirically it does (that's the
 * reported bug this fixes — pressing Generate again during a still-running
 * turn hits that exact guard).
 *
 * `beginGeneration` runs as the very first statement, before any `await`, so
 * two `generate` calls racing for the same session can't both start one:
 * whichever runs second always finds the record the first just created.
 */
export async function beginTrackedGeneration(
	input: GenerateInput,
	mainContext: Context.Context<AppServices>,
): Promise<void> {
	beginGeneration(input.sessionId, input.harness, input.model);
	const iterator = generateWalkthrough(input, mainContext);

	let first: IteratorResult<GenerateEvent>;
	try {
		first = await iterator.next();
	} catch (error) {
		clearGeneration(input.sessionId);
		throw error;
	}
	if (first.done !== true) {
		recordGenerationEvent(input.sessionId, first.value);
	}

	void (async () => {
		try {
			while (true) {
				const next = await iterator.next();
				if (next.done === true) return;
				recordGenerationEvent(input.sessionId, next.value);
			}
		} catch (error) {
			// `generateWalkthrough` only ever throws `GenerateSessionNotFound`,
			// and only as its very first step — already handled above, before
			// this detached loop starts. Anything reaching here is unexpected;
			// record it rather than let it vanish as an unhandled rejection.
			recordGenerationEvent(input.sessionId, {
				type: "failed",
				message: error instanceof Error ? error.message : String(error),
			});
		}
	})();
}
