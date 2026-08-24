import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** Runs `cmd` to completion with inherited stdio, failing if it exits non-zero. */
const run = (cmd: string, args: ReadonlyArray<string>) =>
	Effect.gen(function* () {
		const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
		const exitCode = yield* spawner.exitCode(
			ChildProcess.make(cmd, args, {
				stdin: "inherit",
				stdout: "inherit",
				stderr: "inherit",
			}),
		);
		if (exitCode !== 0) {
			return yield* Effect.fail(
				new Error(`${[cmd, ...args].join(" ")} exited ${exitCode}`),
			);
		}
	});

/**
 * Compiles `entrypoint` into a standalone binary at `outfile`, then strips
 * and re-applies a clean ad-hoc code signature.
 *
 * The re-sign is load-bearing, not cosmetic: `bun build --compile` sometimes
 * miscomputes its code-signature SuperBlob size — a Bun bug that has
 * regressed repeatedly upstream (oven-sh/bun#29120, #29306, #29361,
 * #32159) — and separately, the signature it leaves behind is absent or
 * malformed enough that Apple Silicon SIGKILLs the binary outright rather
 * than merely refusing a later re-sign. Removing whatever bun left and
 * applying a fresh ad-hoc signature here sidesteps both failure modes. This
 * is why the step lives in its own script rather than a `package.json`
 * one-liner — so this comment has somewhere to live and nobody deletes the
 * step as redundant.
 */
const buildBinary = (entrypoint: string, outfile: string) =>
	Effect.gen(function* () {
		yield* run("bun", [
			"build",
			"--compile",
			"--target=bun-darwin-arm64",
			entrypoint,
			"--outfile",
			outfile,
		]);
		yield* run("codesign", ["--remove-signature", outfile]);
		yield* run("codesign", ["--force", "--sign", "-", outfile]);
	});

const entrypoint = process.argv[2];
const outfile = process.argv[3];
if (entrypoint === undefined || outfile === undefined) {
	console.error("usage: build-binary.ts <entrypoint> <outfile>");
	process.exit(1);
}

buildBinary(entrypoint, outfile).pipe(
	Effect.provide(BunServices.layer),
	BunRuntime.runMain,
);
