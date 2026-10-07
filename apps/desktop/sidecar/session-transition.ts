import { Effect } from "effect";
import { emit } from "./events.ts";
import type { OpenSessionOutcome } from "./store.ts";

export const emitSessionTransition = (
	outcome: OpenSessionOutcome,
	close: (sessionId: string) => Effect.Effect<void>,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		for (const transition of outcome.transitions ?? [])
			yield* emitSessionTransition(transition, close);
		if (outcome.kind === "opened") return;
		if (outcome.kind === "retargeted") {
			emit({ type: "session-updated", session: outcome.session });
			return;
		}
		yield* close(outcome.sourceSessionId);
		emit({ type: "session-closed", sessionId: outcome.sourceSessionId });
	});
