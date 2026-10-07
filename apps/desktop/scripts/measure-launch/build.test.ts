import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { buildFingerprint, formatBuild, rebuildReason } from "./build.ts";

test("build stamp reuse requires matching HEAD and contents, and forced builds win", () => {
	const stamp = {
		head: "abc1234",
		hash: "hash",
		hasChanges: false,
		builtAt: "today",
	};
	expect(rebuildReason(stamp, stamp, false, true)).toBeUndefined();
	expect(rebuildReason(stamp, undefined, false, true)).toBe(
		"build stamp is missing",
	);
	expect(rebuildReason(stamp, stamp, true, true)).toBe("--rebuild requested");
	expect(rebuildReason(stamp, stamp, false, false)).toBe("bundle is missing");
	expect(
		rebuildReason({ ...stamp, head: "def4567" }, stamp, false, true),
	).toContain("built on abc1234, HEAD is def4567");
	expect(
		rebuildReason({ ...stamp, hash: "changed" }, stamp, false, true),
	).toContain("uncommitted changes differ");
	expect(formatBuild({ ...stamp, hasChanges: true })).toContain(
		"+ uncommitted changes hash",
	);
});

test("fingerprint includes staged, unstaged and untracked app bytes, excludes docs, scripts and ignored files", async () => {
	const root = mkdtempSync(join(tmpdir(), "nisi-build-stamp-"));
	const fingerprint = () =>
		Effect.runPromise(
			buildFingerprint(root).pipe(Effect.provide(BunServices.layer)),
		);
	try {
		await Bun.$`git init ${root}`.quiet();
		writeFileSync(join(root, "source.ts"), "original");
		writeFileSync(join(root, ".gitignore"), "ignored.ts\n");
		await Bun.$`git add .`.cwd(root).quiet();
		await Bun.$`git -c user.name=test -c user.email=test@example.com commit -m initial`
			.cwd(root)
			.quiet();
		const clean = await fingerprint();
		mkdirSync(join(root, "apps/desktop/scripts/measure-launch"), {
			recursive: true,
		});
		writeFileSync(
			join(root, "apps/desktop/scripts/measure-launch/index.ts"),
			"script",
		);
		writeFileSync(join(root, "README.md"), "docs");
		writeFileSync(join(root, "ignored.ts"), "ignored");
		expect(await fingerprint()).toEqual(clean);
		writeFileSync(join(root, "source.ts"), "changed");
		const changed = await fingerprint();
		expect(changed.hash).not.toBe(clean.hash);
		expect(changed.hasChanges).toBe(true);
		await Bun.$`git add source.ts`.cwd(root).quiet();
		expect(await fingerprint()).toEqual(changed);
		writeFileSync(join(root, "new.ts"), "new");
		expect((await fingerprint()).hash).not.toBe(changed.hash);
	} finally {
		rmSync(root, { recursive: true });
	}
});
