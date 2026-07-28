import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import type { FileSystem } from "effect/FileSystem";
import { hashContent, readBlob, writeBlob } from "../src/blob-store.ts";

const run = <A, E>(effect: Effect.Effect<A, E, FileSystem>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("blob-store", () => {
	test("writes a blob and reads it back by hash", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nisi-blobs-test-"));
		try {
			const content = new TextEncoder().encode("hello world\n");
			const hash = await run(writeBlob(dir, content));
			expect(hash).toBe(hashContent(content));

			const readBack = await run(readBlob(dir, hash));
			expect(new TextDecoder().decode(readBack)).toBe("hello world\n");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("writing the same content twice is idempotent (content-addressed dedup)", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nisi-blobs-test-"));
		try {
			const content = new TextEncoder().encode("same content\n");
			const first = await run(writeBlob(dir, content));
			const second = await run(writeBlob(dir, content));
			expect(second).toBe(first);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test("different content hashes to different addresses", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nisi-blobs-test-"));
		try {
			const a = await run(writeBlob(dir, new TextEncoder().encode("a")));
			const b = await run(writeBlob(dir, new TextEncoder().encode("b")));
			expect(a).not.toBe(b);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
