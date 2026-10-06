import { expect, spyOn, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { readFileContentsAtRef } from "../src/blob.ts";
import { CatFileReaders } from "../src/cat-file.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

test("large blobs concatenate streamed chunks only once, preserving framing", async () => {
	const repo = await makeTestRepo();
	const text = "large\0blob\n".repeat(400_000);
	try {
		await repo.write("large", text);
		await repo.commit("base");
		const originalConcat = Buffer.concat;
		const copies = { bytes: 0 };
		const concat = spyOn(Buffer, "concat").mockImplementation(
			(chunks, length) => {
				const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
				if (size > 16_384) copies.bytes += size;
				return originalConcat(chunks, length);
			},
		);
		try {
			await Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						const original = yield* ChildProcessSpawner.ChildProcessSpawner;
						const readers = yield* CatFileReaders.make.pipe(
							Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
								...original,
								spawn: (command) =>
									original.spawn(command).pipe(
										Effect.map((handle) => ({
											...handle,
											stdout: handle.stdout.pipe(
												Stream.flatMap((bytes) => {
													const chunks: Uint8Array[] = [];
													for (
														let offset = 0;
														offset < bytes.length;
														offset += 1024
													)
														chunks.push(bytes.subarray(offset, offset + 1024));
													return Stream.fromIterable(chunks);
												}),
											),
										})),
									),
							}),
						);
						const replies = yield* readers.request(repo.root, [
							{ command: "contents", expression: "HEAD:large" },
							{ command: "info", expression: "HEAD" },
						]);
						expect(new TextDecoder().decode(replies[0]?.content)).toBe(text);
						expect(replies[1]?.type).toBe("commit");
						expect(copies.bytes).toBe(text.length + 1);
					}),
				).pipe(Effect.provide(BunServices.layer)),
			);
		} finally {
			concat.mockRestore();
		}
	} finally {
		await cleanupTestRepo(repo);
	}
}, 30_000);

test("a stalled repository reader does not block another repository", async () => {
	const first = await makeTestRepo();
	const second = await makeTestRepo();
	try {
		for (const repo of [first, second]) {
			await repo.write("file", "hello");
			await repo.commit("base");
		}
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const original = yield* ChildProcessSpawner.ChildProcessSpawner;
					const gate = yield* Deferred.make<void>();
					const stalled = yield* Deferred.make<void>();
					const state = { spawns: 0 };
					const readers = yield* CatFileReaders.make.pipe(
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
							...original,
							spawn: (command) =>
								original.spawn(command).pipe(
									Effect.map((handle) => {
										state.spawns++;
										return state.spawns === 1
											? {
													...handle,
													stdout: handle.stdout.pipe(
														Stream.tap(() =>
															Deferred.succeed(stalled, undefined).pipe(
																Effect.andThen(Deferred.await(gate)),
															),
														),
													),
												}
											: handle;
									}),
								),
						}),
					);
					const blocked = yield* readers
						.request(first.root, [{ command: "info", expression: "HEAD:file" }])
						.pipe(Effect.forkScoped);
					yield* Deferred.await(stalled);
					const other = yield* readers
						.request(second.root, [
							{ command: "contents", expression: "HEAD:file" },
						])
						.pipe(Effect.timeout("2 seconds"));
					expect(new TextDecoder().decode(other[0]?.content)).toBe("hello");
					yield* Deferred.succeed(gate, undefined);
					expect((yield* Fiber.join(blocked))[0]?.size).toBe(5);
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(first);
		await cleanupTestRepo(second);
	}
});

test("unsupported batch-command falls back to one-shot metadata and contents without retrying the unsupported reader", async () => {
	const repo = await makeTestRepo();
	try {
		await repo.write("file", "hello\0binary\n");
		await repo.commit("base");
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const original = yield* ChildProcessSpawner.ChildProcessSpawner;
					const state = { spawns: 0 };
					const readers = yield* CatFileReaders.make.pipe(
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
							...original,
							spawn: (command) =>
								Effect.suspend(() => {
									state.spawns++;
									return original.spawn(
										state.spawns === 1
											? ChildProcess.make(
													"/bin/sh",
													[
														"-c",
														"printf '%s\\n' \"error: unknown option 'batch-command'\" >&2; exit 129",
													],
													{ stderr: "pipe" },
												)
											: command,
									);
								}),
						}),
					);
					const first = yield* readers.request(repo.root, [
						{ command: "info", expression: "HEAD:file" },
						{ command: "contents", expression: "HEAD:file" },
						{ command: "contents", expression: "HEAD:missing" },
					]);
					expect(first[0]?.size).toBe(13);
					expect(new TextDecoder().decode(first[1]?.content)).toBe(
						"hello\0binary\n",
					);
					expect(first[2]).toBeUndefined();
					expect(state.spawns).toBe(3);
					expect(
						(yield* readers.request(repo.root, [
							{ command: "info", expression: "HEAD:file" },
						]))[0]?.size,
					).toBe(13);
					expect(state.spawns).toBe(4);
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("persistent reader reuses one process, frames binary bytes, serializes concurrent reads and replaces failed readers", async () => {
	const repo = await makeTestRepo();
	try {
		const text = "héllo\n".repeat(30_000);
		await repo.write("large", text);
		await repo.write("binary", "\0\nraw\0\n");
		await repo.write("space name", "spaces\n");
		await repo.commit("base");
		const handles: ChildProcessSpawner.ChildProcessHandle[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const original = yield* ChildProcessSpawner.ChildProcessSpawner;
					const readers = yield* CatFileReaders.make.pipe(
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
							...original,
							spawn: (command) =>
								original.spawn(command).pipe(
									Effect.tap((handle) =>
										Effect.sync(() => {
											handles.push(handle);
										}),
									),
								),
						}),
					);
					const read = readFileContentsAtRef(repo.root, "HEAD", [
						"large",
						"binary",
						"missing",
						"space name",
					]).pipe(Effect.provideService(CatFileReaders, readers));
					const contents = yield* read;
					expect(new TextDecoder().decode(contents.get("large"))).toBe(text);
					expect(new TextDecoder().decode(contents.get("binary"))).toBe(
						"\0\nraw\0\n",
					);
					expect(contents.has("missing")).toBe(false);
					const concurrent = yield* Effect.all([read, read, read], {
						concurrency: "unbounded",
					});
					for (const value of concurrent)
						expect(new TextDecoder().decode(value.get("space name"))).toBe(
							"spaces\n",
						);
					expect(handles).toHaveLength(1);
					const first = handles[0];
					if (first === undefined)
						return yield* Effect.die(new Error("No reader process"));
					yield* first.kill({ killSignal: "SIGKILL" });
					yield* Effect.exit(first.exitCode);
					const failed = yield* Effect.exit(read);
					expect(failed._tag).toBe("Failure");
					expect(new TextDecoder().decode((yield* read).get("large"))).toBe(
						text,
					);
					expect(handles).toHaveLength(2);
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
		for (const handle of handles)
			expect(await Effect.runPromise(handle.isRunning)).toBe(false);
	} finally {
		await cleanupTestRepo(repo);
	}
});

test("reader capacity evicts the least recently used repo and closes all children on scope exit", async () => {
	const repos = await Promise.all(
		Array.from({ length: 5 }, () => makeTestRepo()),
	);
	try {
		for (const repo of repos) {
			await repo.write("file", "content\n");
			await repo.commit("base");
		}
		const handles: ChildProcessSpawner.ChildProcessHandle[] = [];
		await Effect.runPromise(
			Effect.scoped(
				Effect.gen(function* () {
					const original = yield* ChildProcessSpawner.ChildProcessSpawner;
					const readers = yield* CatFileReaders.make.pipe(
						Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, {
							...original,
							spawn: (command) =>
								original.spawn(command).pipe(
									Effect.tap((handle) =>
										Effect.sync(() => {
											handles.push(handle);
										}),
									),
								),
						}),
					);
					for (const repo of repos)
						yield* readers.request(repo.root, [
							{ command: "info", expression: "HEAD:file" },
						]);
					expect(handles).toHaveLength(5);
					const first = handles[0];
					if (first === undefined)
						return yield* Effect.die(new Error("No reader process"));
					expect(yield* first.isRunning).toBe(false);
					for (const handle of handles.slice(1))
						expect(yield* handle.isRunning).toBe(true);
				}),
			).pipe(Effect.provide(BunServices.layer)),
		);
		for (const handle of handles)
			expect(await Effect.runPromise(handle.isRunning)).toBe(false);
	} finally {
		for (const repo of repos) await cleanupTestRepo(repo);
	}
});
