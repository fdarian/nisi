import { expect, test } from "bun:test";
import { Effect } from "effect";
import { subscribe } from "../events.ts";
import { emitSessionTransition } from "../session-transition.ts";

test("correction emits every persisted transition and releases every closed session", async () => {
	const session = {
		id: "correct",
		repoRoot: "/repo",
		target: { kind: "branch", baseRef: "main", headRef: "feature" },
	} as const;
	const events: string[] = [];
	const closed: string[] = [];
	const stop = subscribe((event) => {
		if (event.type === "session-closed")
			events.push(`closed:${event.sessionId}`);
		if (event.type === "session-updated")
			events.push(`updated:${event.session.id}`);
	});
	try {
		await Effect.runPromise(
			emitSessionTransition(
				{
					kind: "existing",
					session,
					sourceSessionId: "provisional",
					transitions: [
						{ kind: "existing", session, sourceSessionId: "branch-source" },
						{ kind: "retargeted", session, sourceSessionId: session.id },
					],
				},
				(id) =>
					Effect.sync(() => {
						closed.push(id);
					}),
			),
		);
		expect(events).toEqual([
			"closed:branch-source",
			"updated:correct",
			"closed:provisional",
		]);
		expect(closed).toEqual(["branch-source", "provisional"]);
	} finally {
		stop();
	}
});
