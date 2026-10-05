import { isAbsolute, join, resolve } from "node:path";
import { resolveRepoRoot } from "@repo/git";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

export const resolveOpenRepoRoot = (cwd: string, provided?: string) =>
	Effect.gen(function* () {
		if (
			provided === undefined ||
			!isAbsolute(provided) ||
			resolve(cwd) !== provided
		)
			return yield* resolveRepoRoot(cwd);
		const fs = yield* FileSystem;
		const verified = yield* Effect.gen(function* () {
			const marker = join(provided, ".git");
			const stat = yield* fs.stat(marker);
			const gitDir =
				stat.type === "Directory"
					? marker
					: resolve(
							provided,
							(yield* fs.readFileString(marker))
								.replace(/^gitdir: /, "")
								.trim(),
						);
			const head = (yield* fs.readFileString(join(gitDir, "HEAD"))).trim();
			const common = yield* fs
				.readFileString(join(gitDir, "commondir"))
				.pipe(
					Effect.catchTag("PlatformError", (error) =>
						error.reason._tag === "NotFound"
							? Effect.succeed(undefined)
							: Effect.fail(error),
					),
				);
			const commonDir =
				common === undefined ? gitDir : resolve(gitDir, common.trim());
			const objects = yield* fs.stat(join(commonDir, "objects"));
			const refs = yield* fs.stat(join(commonDir, "refs"));
			return (
				objects.type === "Directory" &&
				refs.type === "Directory" &&
				(/^ref: refs\/.+/.test(head) || /^[a-f0-9]{40,64}$/.test(head))
			);
		}).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)));
		if (!verified) return yield* resolveRepoRoot(cwd);
		yield* Effect.annotateCurrentSpan("providedRootVerified", true);
		return yield* fs
			.realPath(provided)
			.pipe(Effect.catchTag("PlatformError", () => resolveRepoRoot(cwd)));
	});
