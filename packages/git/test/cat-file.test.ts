import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { readFileContentsAtRef } from "../src/blob.ts";
import { CatFileReaders } from "../src/cat-file.ts";
import { cleanupTestRepo, makeTestRepo } from "./fixtures.ts";

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
