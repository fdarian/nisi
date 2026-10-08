import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { pinnedBaseTip, resolveDiffBase } from "../diff-base.ts";

const sh = async (cwd: string, args: ReadonlyArray<string>) => {
	const proc = Bun.spawn(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = await new Response(proc.stdout).text();
	if ((await proc.exited) !== 0)
		throw new Error(`git ${args.join(" ")} failed`);
	return out.trim();
};

const commit = async (root: string, name: string) => {
	await Bun.write(join(root, name), `${name}\n`);
	await sh(root, ["add", "-A"]);
	await sh(root, ["commit", "-q", "-m", name]);
	return sh(root, ["rev-parse", "HEAD"]);
};

const run = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
	Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));

describe("pinnedBaseTip", () => {
	test("only a MERGED PR pins its base", () => {
		expect(pinnedBaseTip(undefined)).toBeUndefined();
		expect(pinnedBaseTip({ state: "OPEN", baseSha: "b" })).toBeUndefined();
		expect(pinnedBaseTip({ state: "CLOSED", baseSha: "b" })).toBeUndefined();
		expect(pinnedBaseTip({ state: "MERGED", baseSha: "b" })).toBe("b");
	});
});

describe("resolveDiffBase", () => {
	test("keeps the session's base unless the PR is merged", async () => {
		expect(await run(resolveDiffBase("/nonexistent", "main", undefined))).toBe(
			"main",
		);
		expect(
			await run(
				resolveDiffBase("/nonexistent", "main", {
					state: "OPEN",
					baseSha: "abc",
				}),
			),
		).toBe("main");
	});

	test("fetches the base branch when the pinned commit isn't local, and falls back to the live base when it still isn't", async () => {
		const origin = await mkdtemp(join(tmpdir(), "nisi-diff-base-origin-"));
		const parent = await mkdtemp(join(tmpdir(), "nisi-diff-base-clone-"));
		const clone = join(parent, "clone");
		try {
			await sh(origin, ["init", "-q", "-b", "main"]);
			await sh(origin, ["config", "user.email", "t@example.com"]);
			await sh(origin, ["config", "user.name", "T"]);
			await commit(origin, "first.ts");
			await sh(parent, ["clone", "-q", origin, clone]);
			const pinned = await commit(origin, "second.ts");

			expect(
				await run(
					resolveDiffBase(clone, "main", { state: "MERGED", baseSha: pinned }),
				),
			).toBe(pinned);
			expect(await sh(clone, ["cat-file", "-t", pinned])).toBe("commit");

			const unreachable = "0123456789abcdef0123456789abcdef01234567";
			expect(
				await run(
					resolveDiffBase(clone, "main", {
						state: "MERGED",
						baseSha: unreachable,
					}),
				),
			).toBe("main");
		} finally {
			await rm(origin, { recursive: true, force: true });
			await rm(parent, { recursive: true, force: true });
		}
	});
});
