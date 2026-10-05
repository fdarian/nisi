import {
	Context,
	Effect,
	Exit,
	Layer,
	Queue,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./errors.ts";
import { spawnCatFile } from "./exec.ts";

type Reply = {
	object: string;
	type: string;
	size: number;
	content?: Uint8Array;
};
type Input = { command: "info" | "contents"; expression: string };
type Incoming =
	| { type: "bytes"; bytes: Uint8Array }
	| { type: "ended" }
	| { type: "failed"; cause: unknown };

const openReader = (repoRoot: string) =>
	Effect.gen(function* () {
		const handle = yield* spawnCatFile(repoRoot);
		const outgoing = yield* Queue.bounded<Uint8Array>(16);
		const incoming = yield* Queue.bounded<Incoming>(16);
		const error = (cause: unknown) =>
			new GitCommandError({
				command: "git",
				args: ["cat-file", "--batch-command", "--buffer"],
				cwd: repoRoot,
				exitCode: null,
				stderr: "persistent cat-file stream failed",
				cause,
			});
		yield* Stream.run(Stream.fromQueue(outgoing), handle.stdin).pipe(
			Effect.catchCause((cause) =>
				Queue.offer(incoming, { type: "failed", cause }),
			),
			Effect.forkScoped,
		);
		yield* Stream.runForEach(handle.stdout, (bytes) =>
			Queue.offer(incoming, { type: "bytes", bytes }),
		).pipe(
			Effect.andThen(Queue.offer(incoming, { type: "ended" })),
			Effect.catchCause((cause) =>
				Queue.offer(incoming, { type: "failed", cause }),
			),
			Effect.forkScoped,
		);
		const state = { bytes: Buffer.alloc(0) };
		const refill = Effect.gen(function* () {
			const next = yield* Queue.take(incoming);
			if (next.type !== "bytes")
				return yield* error(
					next.type === "failed"
						? next.cause
						: new Error("cat-file closed stdout"),
				);
			state.bytes = Buffer.concat([state.bytes, next.bytes]);
		});
		const request = (inputs: readonly Input[]) =>
			Effect.gen(function* () {
				if (inputs.some((input) => /\n/.test(input.expression)))
					return yield* error(
						new Error("cat-file expressions cannot contain line breaks"),
					);
				yield* Queue.offer(
					outgoing,
					new TextEncoder().encode(
						`${inputs.map((input) => `${input.command} ${input.expression}\n`).join("")}flush\n`,
					),
				);
				const replies: Array<Reply | undefined> = [];
				for (const input of inputs) {
					while (state.bytes.indexOf(10) < 0) yield* refill;
					const end = state.bytes.indexOf(10);
					const line = state.bytes.subarray(0, end).toString("utf8");
					state.bytes = state.bytes.subarray(end + 1);
					if (line.endsWith(" missing")) {
						replies.push(undefined);
						continue;
					}
					const fields = line.split(" ");
					const object = fields[0];
					const type = fields[1];
					const size = Number(fields[2]);
					if (
						object === undefined ||
						!/^[a-f0-9]{40,64}$/.test(object) ||
						type === undefined ||
						!Number.isSafeInteger(size) ||
						size < 0
					)
						return yield* error(new Error(`Invalid cat-file header: ${line}`));
					if (input.command === "info") {
						replies.push({ object, type, size });
						continue;
					}
					while (state.bytes.length < size + 1) yield* refill;
					if (state.bytes[size] !== 10)
						return yield* error(
							new Error("Invalid cat-file content terminator"),
						);
					replies.push({
						object,
						type,
						size,
						content: Uint8Array.from(state.bytes.subarray(0, size)),
					});
					state.bytes = state.bytes.subarray(size + 1);
				}
				return replies;
			}).pipe(Effect.withSpan("git.cat-file.request"));
		return { request };
	});

export class CatFileReaders extends Context.Service<CatFileReaders>()(
	"git/CatFileReaders",
	{
		make: Effect.gen(function* () {
			const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
			const lock = Semaphore.makeUnsafe(1);
			const readers = new Map<
				string,
				{
					scope: Scope.Closeable;
					reader: Effect.Success<ReturnType<typeof openReader>>;
					usedAt: number;
				}
			>();
			const close = (repoRoot: string) =>
				Effect.gen(function* () {
					const entry = readers.get(repoRoot);
					if (entry === undefined) return;
					readers.delete(repoRoot);
					yield* Scope.close(entry.scope, Exit.void);
				});
			yield* Effect.addFinalizer(() =>
				Effect.forEach([...readers.keys()], close, { discard: true }),
			);
			yield* lock
				.withPermit(
					Effect.gen(function* () {
						for (const entry of readers)
							if (Date.now() - entry[1].usedAt > 60_000) yield* close(entry[0]);
					}),
				)
				.pipe(Effect.delay("30 seconds"), Effect.forever, Effect.forkScoped);
			const request = (repoRoot: string, inputs: readonly Input[]) =>
				lock.withPermit(
					Effect.gen(function* () {
						const existing = readers.get(repoRoot);
						const entry =
							existing === undefined
								? yield* Effect.gen(function* () {
										if (readers.size >= 4) {
											const oldest = [...readers.entries()].sort(
												(a, b) => a[1].usedAt - b[1].usedAt,
											)[0];
											if (oldest !== undefined) yield* close(oldest[0]);
										}
										const scope = yield* Scope.make();
										const reader = yield* openReader(repoRoot).pipe(
											Effect.provideService(Scope.Scope, scope),
											Effect.provideService(
												ChildProcessSpawner.ChildProcessSpawner,
												spawner,
											),
											Effect.onExit((exit) =>
												Exit.isFailure(exit)
													? Scope.close(scope, exit)
													: Effect.void,
											),
										);
										const created = { scope, reader, usedAt: Date.now() };
										readers.set(repoRoot, created);
										return created;
									})
								: existing;
						entry.usedAt = Date.now();
						return yield* entry.reader.request(inputs).pipe(
							Effect.timeout("15 seconds"),
							Effect.mapError((cause) =>
								cause instanceof GitCommandError
									? cause
									: new GitCommandError({
											command: "git",
											args: ["cat-file"],
											cwd: repoRoot,
											exitCode: null,
											stderr: "cat-file request timed out",
											cause,
										}),
							),
							Effect.onExit((exit) =>
								Exit.isFailure(exit) ? close(repoRoot) : Effect.void,
							),
						);
					}),
				);
			return { request };
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make);
}
