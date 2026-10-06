import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { buildFingerprint } from "./build.ts";
import { cliScope, formatCli } from "./cli.ts";

test("CLI report identifies the compiled artifact and stamped commit", () => {
	expect(
		formatCli({
			path: "/bundle/Contents/MacOS/nisi-cli",
			stamp: {
				head: "abcdef123",
				hash: "hash",
				hasChanges: false,
				builtAt: "today",
			},
		}),
	).toBe(
		"CLI: compiled binary /bundle/Contents/MacOS/nisi-cli — Build abcdef1",
	);
});
test("CLI fingerprint excludes desktop changes but tracks CLI and transitive dependency contents", async () => {
	const root = mkdtempSync(join(tmpdir(), "nisi-cli-stamp-"));
	const fingerprint = () =>
		Effect.runPromise(
			buildFingerprint(root, cliScope).pipe(Effect.provide(BunServices.layer)),
		);
	try {
		mkdirSync(join(root, "packages/cli/src"), { recursive: true });
		mkdirSync(join(root, "packages/git/src"), { recursive: true });
		mkdirSync(join(root, "apps/desktop/src"), { recursive: true });
		writeFileSync(join(root, "packages/cli/src/index.ts"), "cli");
		await Bun.$`git init ${root}`.quiet();
		await Bun.$`git add .`.cwd(root).quiet();
		await Bun.$`git -c user.name=test -c user.email=test@example.com commit -m initial`
			.cwd(root)
			.quiet();
		const clean = await fingerprint();
		writeFileSync(join(root, "apps/desktop/src/main.ts"), "frontend");
		writeFileSync(join(root, "packages/cli/README.md"), "docs");
		expect(await fingerprint()).toEqual(clean);
		writeFileSync(join(root, "packages/git/src/exec.ts"), "git dependency");
		expect((await fingerprint()).hash).not.toBe(clean.hash);
	} finally {
		rmSync(root, { recursive: true });
	}
});
