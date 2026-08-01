import { Context, Effect, Layer, Ref } from "effect";

/**
 * The set of session ids the live-poll loop (`live-poll.ts`) should actually
 * check on each tick — a `Ref`-backed service, not a module-level mutable
 * global, since two separate modules touch this state: `http.ts`'s
 * `sessions.setWatching`/`sessions.close` handlers write it (in response to
 * the frontend's focus/tab predicate — see `apps/desktop/src/lib/pr-data.ts`),
 * and `live-poll.ts`'s `pollOnce` reads it every tick to narrow which open
 * sessions actually get polled. Membership here is orthogonal to a session
 * being *open* (`Store.listSessions()`) — a session can be open but unwatched
 * (backgrounded, or Files Changed isn't the active tab) the same way a poller
 * tick already treats a transient per-session git failure as "try again next
 * tick" rather than a hard error.
 */
export class SessionWatch extends Context.Service<SessionWatch>()(
	"SessionWatch",
	{
		make: Effect.gen(function* () {
			const watched = yield* Ref.make<ReadonlySet<string>>(new Set());

			const add = (sessionId: string) =>
				Ref.update(watched, (ids) => new Set(ids).add(sessionId));

			const remove = (sessionId: string) =>
				Ref.update(watched, (ids) => {
					if (!ids.has(sessionId)) return ids;
					const next = new Set(ids);
					next.delete(sessionId);
					return next;
				});

			const list = () => Ref.get(watched);

			return { add, remove, list };
		}),
	},
) {
	static layer = Layer.effect(SessionWatch, SessionWatch.make);
}
