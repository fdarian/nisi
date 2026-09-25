import { type Context, Effect, Exit, Fiber, Option, Stream } from "effect";

export async function* streamToIterator<A, E, R>(
	stream: Stream.Stream<A, E, R>,
	context: Context.Context<R>,
	signal?: AbortSignal,
): AsyncGenerator<A, void, void> {
	const pending: A[] = [];
	let wake: (() => void) | undefined;
	let exit: Exit.Exit<void, E> | undefined;
	const notify = () => {
		const resolve = wake;
		wake = undefined;
		resolve?.();
	};
	const fiber = Effect.runForkWith(context)(
		Stream.runForEach(stream, (value) =>
			Effect.sync(() => {
				pending.push(value);
				notify();
			}),
		),
		{ signal },
	);
	const removeObserver = fiber.addObserver((result) => {
		exit = result;
		notify();
	});
	try {
		while (exit === undefined || pending.length > 0) {
			const next = pending.shift();
			if (next !== undefined) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				wake = resolve;
			});
		}
		if (
			signal?.aborted !== true &&
			exit !== undefined &&
			Exit.isFailure(exit)
		) {
			const failure = Exit.findErrorOption(exit);
			if (Option.isSome(failure)) throw failure.value;
			await Effect.runPromise(Effect.failCause(exit.cause));
		}
	} finally {
		removeObserver();
		await Effect.runPromise(Fiber.interrupt(fiber));
	}
}
