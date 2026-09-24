import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";
import {
	ensureNpmTarball,
	NpmTarballInstallError,
	verifyIntegrity,
} from "../src/index.ts";

const root = mkdtempSync(join(tmpdir(), "npm-tarball-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const source = join(root, "source");
mkdirSync(join(source, "package", "bin"), { recursive: true });
writeFileSync(join(source, "package", "bin", "tool"), "hello");
const archive = join(root, "archive.tgz");
const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", source, "package"]);
if (tar.exitCode !== 0) throw new Error(tar.stderr.toString());
const bytes = readFileSync(archive);
const release = {
	packageName: "@example/tool-darwin-arm64",
	version: "1.0.0",
	integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
};
const validate = (directory: string) =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;
		return yield* fs
			.exists(join(directory, "bin", "tool"))
			.pipe(
				Effect.mapError(
					(cause) => new NpmTarballInstallError({ reason: "cache", cause }),
				),
			);
	});

test("concurrent installs share a verified archive and reuse a complete cache", async () => {
	const target = join(root, "cache", "1.0.0");
	let downloads = 0;
	const install = () =>
		Effect.runPromise(
			ensureNpmTarball(target, release, {
				sourceDirectory: "package",
				validate,
				downloadTarball: () =>
					Effect.sync(() => {
						downloads++;
						return bytes;
					}),
			}).pipe(Effect.provide(BunServices.layer)),
		);
	const results = await Promise.all([install(), install(), install()]);
	expect(results).toEqual([target, target, target]);
	expect(downloads).toBe(1);
	expect(readFileSync(join(target, "bin", "tool"), "utf8")).toBe("hello");
	await install();
	expect(downloads).toBe(1);
});

test("rejects bytes with the wrong SHA-512 pin", async () => {
	const result = await Effect.runPromiseExit(
		verifyIntegrity(bytes, { ...release, integrity: "sha512-invalid" }),
	);
	expect(result._tag).toBe("Failure");
});
