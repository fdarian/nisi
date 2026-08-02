import { basename, dirname } from "node:path";
import { DevToolsTelemetry } from "@ai-sdk/devtools";
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
	WALKTHROUGH_TOOL_NAMES,
} from "@repo/walkthrough";
import { registerTelemetry } from "ai";
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

/**
 * HarnessAgent drives AI SDK's own `Telemetry` contract per turn (see its
 * `telemetry` option below), but stays OpenTelemetry-agnostic itself — an
 * integration has to be registered from the consumer side. Opt-in via
 * `AI_SDK_DEVTOOLS=1` (then `npx @ai-sdk/devtools` for the viewer); with
 * nothing registered the dispatcher no-ops, so leaving this unset costs
 * nothing.
 */
if (process.env.AI_SDK_DEVTOOLS === "1") {
	registerTelemetry(DevToolsTelemetry());
}

/** Bounded write → validate → feedback → edit loop. Never infinite: an agent that can't converge fails loudly instead of burning turns forever. */
const MAX_TURNS = 4;

/**
 * Each adapter's builtin tools that write to the filesystem, switched off for
 * the whole generation. A walkthrough is prose *about* a diff — nothing here
 * ever needs to modify the worktree, and the worktree is the user's real repo,
 * not a disposable sandbox. Claude Code proved the risk concrete: on a large
 * digest it called its builtin `Write` rather than the walkthrough tool and
 * left a stray `walkthrough.json` in the repo root.
 *
 * Renaming our own tools out of the way (`WALKTHROUGH_TOOL_NAMES`) stops the
 * model from *confusing* the two; this stops it from reaching a file writer at
 * all, whichever one it reaches for. Codex exposes no file-writing builtin
 * (only `bash`/`webSearch`), hence the empty list.
 *
 * `bash` is deliberately left active — the agent needs it to explore beyond
 * the digest, and it's the one remaining way to touch disk. That's a narrower
 * hole than an editing tool the model reaches for by habit, but it is a hole.
 */
const FILE_MUTATING_BUILTINS: Record<HarnessId, ReadonlyArray<string>> = {
	"claude-code": ["write", "edit", "NotebookEdit"],
	codex: [],
	opencode: ["write", "edit"],
	pi: ["write", "edit"],
};

/** Thrown (not yielded) so `http.ts`'s handler can map it to the contract's declared `NOT_FOUND`, the same treatment `diff.files`/`diff.fileContents` give an unknown session — everything else that can go wrong mid-generation yields an in-band `failed` event instead of tearing down the stream. */
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

/**
 * `fullStream`'s `error` parts carry whatever the adapter's own transport
 * failed with — an unconfigured provider ("No API key found for the selected
 * model. Use /login…"), a revoked token, a model the CLI rejects. The stream
 * still ends *normally* after one, so nothing throws and the turn simply
 * produces no tool calls; before this was read, that surfaced as an empty
 * buffer, four identical "you haven't written the walkthrough yet" retries,
 * and a final message blaming coverage validation for what was really an auth
 * failure the harness had already described precisely.
 *
 * Returns `undefined` for a part carrying no payload at all. OpenCode's bridge
 * emits a bare `{ type: "error" }` partway through a busy session (see
 * `patches/@ai-sdk%2Fharness@1.0.46.patch`, which is what lets it decode
 * rather than tear the stream down); it says nothing, arrives on runs that are
 * otherwise fine, and must not abort a generation that is about to succeed.
 * Anything with real content still fails the turn.
 */
const describeStreamError = (error: unknown): string | undefined => {
	if (error === undefined || error === null) return undefined;
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error.length === 0 ? undefined : error;
	if (
		typeof error === "object" &&
		"message" in error &&
		typeof error.message === "string"
	) {
		return error.message;
	}
	return JSON.stringify(error);
};

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
	// The same pair feeds both the harness (which registers these keys) and the
	// prompt (which tells the model what to call) — they must never diverge.
	const toolNames = WALKTHROUGH_TOOL_NAMES;
	const walkthroughTools = createWalkthroughTools(buffer, toolNames);
	const agent = new HarnessAgent({
		harness: createHarnessAdapter(input.harness, input.model),
		sandbox,
		sandboxConfig: { workDir: basename(repoRoot) },
		tools: {
			[toolNames.write]: walkthroughTools.write,
			[toolNames.edit]: walkthroughTools.edit,
		},
		inactiveTools: FILE_MUTATING_BUILTINS[input.harness],
		instructions: buildSystemPrompt(toolNames),
		telemetry: {},
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

		const streamErrors: Array<string> = [];
		try {
			const result = await agent.stream({ session, prompt: turnPrompt });
			for await (const part of result.fullStream) {
				if (part.type === "tool-call") {
					yield {
						type: "tool-call",
						turn,
						toolName: part.toolName,
						input: part.input,
					};
				}
				if (part.type === "error") {
					const described = describeStreamError(part.error);
					if (described !== undefined) streamErrors.push(described);
				}
			}
		} catch (error) {
			// A thrown failure always fails the turn, even if it describes
			// itself poorly — unlike an in-band `error` part, it already tore
			// the stream down, so there's nothing left to salvage.
			streamErrors.push(
				describeStreamError(error) ?? "The harness stream failed.",
			);
		}

		// Fails the whole generation rather than spending another turn: the
		// harness reported its own transport failure, and nothing about a retry
		// with the same session, model, and credentials would change the answer
		// — unlike a validation miss, which the next turn genuinely can fix.
		if (streamErrors.length > 0) {
			yield { type: "failed", message: streamErrors.join("\n") };
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
			// Carries the last turn's feedback verbatim rather than naming
			// "coverage/reference validation" — the loop rejects a walkthrough for
			// several unrelated reasons (nothing written at all, malformed JSON, a
			// reference pointing nowhere, genuinely uncovered lines), and naming
			// one category told users the thing that often hadn't happened. The
			// feedback already lists the exact files and line ranges left
			// unclaimed when coverage really is what failed.
			yield {
				type: "failed",
				message: `The agent couldn't produce a valid walkthrough in ${MAX_TURNS} turns. Last problem:\n\n${evaluation.feedback}`,
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
 * of nothing.
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
