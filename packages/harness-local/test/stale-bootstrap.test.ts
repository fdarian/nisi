import { expect, test } from "bun:test";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LocalSandboxProvider } from "../src/local-sandbox-provider.ts";
import { invalidateStaleBootstraps } from "../src/stale-bootstrap.ts";
import { cleanupTempDir, makeTempDir } from "./fixtures.ts";

test("removes all stale markers before the bootstrap callback", async () => {
	const root = await makeTempDir();
	try {
		const dir = join(root, ".harness-bootstrap", "claude-code");
		await mkdir(join(dir, "node_modules"), { recursive: true });
		await writeFile(join(dir, "package.json"), "{}");
		await writeFile(join(dir, ".bootstrap-old.ok"), "");
		await writeFile(join(dir, ".bootstrap-new.ok"), "");
		await writeFile(join(dir, "bridge.mjs"), "");
		const provider = new LocalSandboxProvider({
			defaultWorkingDirectory: root,
		});
		const session = await provider.createSession({
			onFirstCreate: async () => {
				expect((await readdir(dir)).sort()).toEqual([
					"bridge.mjs",
					"node_modules",
					"package.json",
				]);
			},
		});
		await session.stop();
	} finally {
		await cleanupTempDir(root);
	}
});

test("removes stale markers when node_modules is entirely missing", async () => {
	const root = await makeTempDir();
	try {
		const dir = join(root, ".harness-bootstrap", "codex");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, "package.json"), "{}");
		await writeFile(join(dir, ".bootstrap-old.ok"), "");
		await invalidateStaleBootstraps(root);
		expect(await readdir(dir)).toEqual(["package.json"]);
	} finally {
		await cleanupTempDir(root);
	}
});

test("leaves healthy bootstrap directories untouched", async () => {
	const root = await makeTempDir();
	try {
		const dir = join(root, ".harness-bootstrap", "opencode");
		await mkdir(join(dir, "node_modules"), { recursive: true });
		await writeFile(join(dir, "package.json"), "{}");
		await writeFile(join(dir, ".bootstrap-old.ok"), "");
		await writeFile(join(dir, "node_modules", ".modules.yaml"), "{}");
		const before = await readdir(dir);
		await invalidateStaleBootstraps(root);
		expect(await readdir(dir)).toEqual(before);
	} finally {
		await cleanupTempDir(root);
	}
});

test("leaves directories without package.json untouched", async () => {
	const root = await makeTempDir();
	try {
		const dir = join(root, ".harness-bootstrap", "custom");
		await mkdir(dir, { recursive: true });
		await writeFile(join(dir, ".bootstrap-old.ok"), "");
		await invalidateStaleBootstraps(root);
		expect(await readdir(dir)).toEqual([".bootstrap-old.ok"]);
	} finally {
		await cleanupTempDir(root);
	}
});

test("missing bootstrap root is a no-op", async () => {
	const root = await makeTempDir();
	try {
		await invalidateStaleBootstraps(root);
		expect(await readdir(root)).toEqual([]);
	} finally {
		await cleanupTempDir(root);
	}
});

test("propagates filesystem errors other than missing paths", async () => {
	const root = await makeTempDir();
	try {
		await writeFile(join(root, ".harness-bootstrap"), "");
		await expect(invalidateStaleBootstraps(root)).rejects.toMatchObject({
			code: "ENOTDIR",
		});
	} finally {
		await cleanupTempDir(root);
	}
});
