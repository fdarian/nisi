import {
	Context,
	Effect,
	Exit,
	Fiber,
	Layer,
	Queue,
	Scope,
	Semaphore,
	Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { GitCommandError } from "./errors.ts";
import { gitBytes, spawnCatFile } from "./exec.ts";

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

const requestOnce = (repoRoot: string, inputs: readonly Input[]) =>
	Effect.gen(function* () {
		const replies: Array<Reply | undefined> = [];
		for (const command of ["info", "contents"] as const) {
			const selected = inputs
				.map((input, index) => ({ input, index }))
				.filter((item) => item.input.command === command);
			if (selected.length === 0) continue;
			const output = yield* gitBytes(
				repoRoot,
				["cat-file", command === "info" ? "--batch-check" : "--batch"],
				`${selected.map((item) => item.input.expression).join("\n")}\n`,
			);
			const cursor = { offset: 0 };
			for (const item of selected) {
				const end = output.indexOf(10, cursor.offset);
				const line = output.subarray(cursor.offset, end).toString("utf8");
				cursor.offset = end + 1;
				if (line.endsWith(" missing")) {
					replies[item.index] = undefined;
					continue;
				}
				const fields = line.split(" ");
				const object = fields[0];
				const type = fields[1];
				const size = Number(fields[2]);
				if (
					end < 0 ||
					object === undefined ||
					!/^[a-f0-9]{40,64}$/.test(object) ||
					type === undefined ||
					!Number.isSafeInteger(size) ||
					size < 0 ||
					(command === "contents" && output[cursor.offset + size] !== 10)
				)
					return yield* new GitCommandError({
						command: "git",
						args: ["cat-file"],
						cwd: repoRoot,
						exitCode: null,
						stderr: "Invalid one-shot cat-file reply",
						cause: new Error(line),
					});
				replies[item.index] = {
					object,
					type,
					size,
					...(command === "contents"
						? { content: output.subarray(cursor.offset, cursor.offset + size) }
						: {}),
				};
				if (command === "contents") cursor.offset += size + 1;
			}
		}
		return replies;
	});

const openReader = (repoRoot: string) =>
	Effect.gen(function* () {
		const handle = yield* spawnCatFile(repoRoot);
		const outgoing = yield* Queue.bounded<Uint8Array>(16);
		const incoming = yield* Queue.bounded<Incoming>(16);
		const stderr: Uint8Array[] = [];
		const stderrFiber = yield* Stream.runForEach(handle.stderr, (bytes) =>
			Effect.sync(() => {
				stderr.push(bytes);
			}),
		).pipe(Effect.forkScoped);
		const error = (cause: unknown, closed = false) =>
			Effect.gen(function* () {
				const exitCode = closed ? Number(yield* handle.exitCode) : null;
				if (closed) yield* Fiber.join(stderrFiber);
				return yield* new GitCommandError({
					command: "git",
					args: ["cat-file", "--batch-command", "--buffer"],
					cwd: repoRoot,
					exitCode,
					stderr:
						stderr.length === 0
							? "persistent cat-file stream failed"
							: Buffer.concat(stderr).toString("utf8"),
					cause,
				});
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
		const state: { bytes: Buffer } = { bytes: Buffer.alloc(0) };
		const refill = Effect.gen(function* () {
			const next = yield* Queue.take(incoming);
			if (next.type !== "bytes")
				return yield* error(
					next.type === "failed"
						? next.cause
						: new Error("cat-file closed stdout"),
					true,
				);
			state.bytes = Buffer.from(
				next.bytes.buffer,
				next.bytes.byteOffset,
				next.bytes.byteLength,
			);
		});
		const readLine = Effect.gen(function* () {
			const chunks: Uint8Array[] = [];
			while (true) {
				if (state.bytes.length === 0) yield* refill;
				const end = state.bytes.indexOf(10);
				if (end >= 0) {
					chunks.push(state.bytes.subarray(0, end));
					state.bytes = state.bytes.subarray(end + 1);
					return Buffer.concat(chunks).toString("utf8");
				}
				chunks.push(state.bytes);
				state.bytes = Buffer.alloc(0);
			}
		});
		const readBytes = (size: number) =>
			Effect.gen(function* () {
				const chunks: Uint8Array[] = [];
				const progress = { remaining: size };
				while (progress.remaining > 0) {
					if (state.bytes.length === 0) yield* refill;
					const count = Math.min(progress.remaining, state.bytes.length);
					chunks.push(state.bytes.subarray(0, count));
					state.bytes = state.bytes.subarray(count);
					progress.remaining -= count;
				}
				return Buffer.concat(chunks, size);
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
					const line = yield* readLine;
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
					const content = yield* readBytes(size + 1);
					if (content[size] !== 10)
						return yield* error(
							new Error("Invalid cat-file content terminator"),
						);
					replies.push({
						object,
						type,
						size,
						content: content.subarray(0, size),
					});
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
			const support = { batchCommand: true };
			const readers = new Map<
				string,
				{
					scope: Scope.Closeable;
					reader: Effect.Success<ReturnType<typeof openReader>>;
					usedAt: number;
					users: number;
					lock: Semaphore.Semaphore;
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
							if (entry[1].users === 0 && Date.now() - entry[1].usedAt > 60_000)
								yield* close(entry[0]);
					}),
				)
				.pipe(Effect.delay("30 seconds"), Effect.forever, Effect.forkScoped);
			const request = (repoRoot: string, inputs: readonly Input[]) =>
				Effect.gen(function* () {
					if (inputs.some((input) => /\n/.test(input.expression)))
						return yield* new GitCommandError({
							command: "git",
							args: ["cat-file"],
							cwd: repoRoot,
							exitCode: null,
							stderr: "cat-file expressions cannot contain line breaks",
							cause: new Error("invalid expression"),
						});
					const fallback = requestOnce(repoRoot, inputs).pipe(
						Effect.provideService(
							ChildProcessSpawner.ChildProcessSpawner,
							spawner,
						),
					);
					if (!support.batchCommand) return yield* fallback;
					const entry = yield* lock.withPermit(
						Effect.gen(function* () {
							const existing = readers.get(repoRoot);
							const selected =
								existing === undefined
									? yield* Effect.gen(function* () {
											if (readers.size >= 4) {
												const oldest = [...readers.entries()]
													.filter((entry) => entry[1].users === 0)
													.sort((a, b) => a[1].usedAt - b[1].usedAt)[0];
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
											const created = {
												scope,
												reader,
												usedAt: Date.now(),
												users: 0,
												lock: Semaphore.makeUnsafe(1),
											};
											readers.set(repoRoot, created);
											return created;
										})
									: existing;
							selected.users++;
							selected.usedAt = Date.now();
							return selected;
						}),
					);
					const invalidate = lock.withPermit(
						Effect.suspend(() =>
							readers.get(repoRoot) === entry ? close(repoRoot) : Effect.void,
						),
					);
					return yield* entry.lock
						.withPermit(
							Effect.gen(function* () {
								if (readers.get(repoRoot) !== entry) return yield* fallback;
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
									Effect.catchTag("GitCommandError", (cause) =>
										Effect.gen(function* () {
											yield* invalidate;
											if (
												!/(?:unknown|unrecognized|unsupported).*batch-command/i.test(
													cause.stderr,
												)
											)
												return yield* cause;
											support.batchCommand = false;
											return yield* fallback;
										}),
									),
									Effect.onExit((exit) =>
										Exit.isFailure(exit) ? invalidate : Effect.void,
									),
								);
							}),
						)
						.pipe(
							Effect.ensuring(
								Effect.gen(function* () {
									entry.users--;
									entry.usedAt = Date.now();
									if (readers.size > 4 && entry.users === 0) yield* invalidate;
								}),
							),
						);
				});
			return { request };
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make);
}
