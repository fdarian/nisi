import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { WorktreeReadFailed } from "@repo/git";
import { Effect } from "effect";
import { FileSystem } from "effect/FileSystem";

/** Content fingerprints catch packed refs and same-size/same-mtime rewrites; unsupported layouts stay on git. */
export const readRefState = (
	repoRoot: string,
	baseRef: string,
	headRef = "HEAD",
) =>
	Effect.gen(function* () {
		if (
			[baseRef, headRef].some(
				(ref) => !/^[a-zA-Z0-9_./-]+$/.test(ref) || ref.includes(".."),
			)
		)
			return undefined;
		const fs = yield* FileSystem;
		const optional = (path: string) =>
			fs.stat(path).pipe(
				Effect.flatMap((stat) =>
					stat.type === "Directory"
						? Effect.succeed(undefined)
						: fs.readFileString(path),
				),
				Effect.catchTag("PlatformError", (error) =>
					error.reason._tag === "NotFound"
						? Effect.succeed(undefined)
						: Effect.fail(error),
				),
			);
		const marker = join(repoRoot, ".git");
		if (!(yield* fs.exists(marker))) return undefined;
		const stat = yield* fs.stat(marker);
		const gitDir =
			stat.type === "Directory"
				? marker
				: yield* optional(marker).pipe(
						Effect.map((text) =>
							text?.startsWith("gitdir: ")
								? resolve(repoRoot, text.slice(8).trim())
								: undefined,
						),
					);
		if (gitDir === undefined) return undefined;
		const common = yield* optional(join(gitDir, "commondir"));
		const commonDir =
			common === undefined ? gitDir : resolve(gitDir, common.trim());
		if (yield* fs.exists(join(commonDir, "reftable"))) return undefined;
		const config = yield* optional(join(commonDir, "config"));
		if (
			config === undefined ||
			/\[include/i.test(config) ||
			!/\[remote "origin"\]/.test(config)
		)
			return undefined;
		const hash = createHash("sha256");
		hash.update(gitDir).update(commonDir).update(config);
		const remoteDir = join(commonDir, "refs/remotes");
		const remotes = (yield* fs.exists(remoteDir))
			? yield* fs.readDirectory(remoteDir)
			: [];
		hash.update(JSON.stringify(remotes.sort()));
		const files = [
			join(gitDir, "HEAD"),
			join(gitDir, "config.worktree"),
			join(commonDir, "packed-refs"),
			join(commonDir, "shallow"),
			join(commonDir, "info/grafts"),
			join(commonDir, "objects/info/alternates"),
		];
		const replaceDir = join(commonDir, "refs/replace");
		if (
			(yield* fs.exists(replaceDir)) &&
			(yield* fs.readDirectory(replaceDir)).length > 0
		)
			return undefined;
		for (const ref of [baseRef, headRef]) {
			if (ref === "HEAD") continue;
			files.push(
				join(commonDir, ref),
				join(commonDir, `refs/${ref}`),
				join(commonDir, `refs/heads/${ref}`),
				join(commonDir, `refs/tags/${ref}`),
				join(commonDir, `refs/remotes/${ref}`),
				join(commonDir, `refs/remotes/${ref}/HEAD`),
			);
			for (const remote of remotes)
				files.push(join(commonDir, `refs/remotes/${remote}/${ref}`));
		}
		const head = yield* optional(join(gitDir, "HEAD"));
		if (head?.startsWith("ref: "))
			files.push(join(commonDir, head.slice(5).trim()));
		const values = yield* Effect.forEach(
			files.sort(),
			(path) => optional(path).pipe(Effect.map((text) => ({ path, text }))),
			{ concurrency: 16 },
		);
		for (const value of values) {
			hash.update(JSON.stringify(value));
			if (
				value.path.endsWith("config.worktree") &&
				value.text !== undefined &&
				/\[include/i.test(value.text)
			)
				return undefined;
			if (
				value.text?.startsWith("ref: ") &&
				value.path !== join(gitDir, "HEAD")
			)
				return undefined;
		}
		return hash.digest("hex");
	}).pipe(
		Effect.mapError(
			(cause) => new WorktreeReadFailed({ path: repoRoot, cause }),
		),
	);
