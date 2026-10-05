import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { WorktreeReadFailed } from "@repo/git";
import { Config, Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";

const sharedRef = (ref: string) =>
	/^refs\/(heads|tags|remotes)\//.test(ref) && validRef(ref);

const validRef = (ref: string) =>
	/^[a-zA-Z0-9_./-]+$/.test(ref) &&
	!ref.includes("..") &&
	!ref.endsWith(".") &&
	ref
		.split("/")
		.every(
			(part) =>
				part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
		);

const supportedRef = (ref: string) =>
	ref === "HEAD" ||
	(validRef(ref) &&
		(!/^[a-fA-F0-9]+$/.test(ref) || ref.length === 40 || ref.length === 64) &&
		!/^([A-Z_]+|main-worktree|worktrees)(\/|$)/.test(ref) &&
		(!ref.startsWith("refs/") || sharedRef(ref)));

/** Content fingerprints catch packed refs and same-size/same-mtime rewrites; unsupported layouts stay on git. */
export const readRefState = (
	repoRoot: string,
	baseRef: string,
	headRef = "HEAD",
) =>
	Effect.gen(function* () {
		if (![baseRef, headRef].every(supportedRef)) return undefined;
		const overrides = yield* Effect.forEach(
			[
				"GIT_DIR",
				"GIT_COMMON_DIR",
				"GIT_WORK_TREE",
				"GIT_NAMESPACE",
				"GIT_OBJECT_DIRECTORY",
				"GIT_ALTERNATE_OBJECT_DIRECTORIES",
				"GIT_CONFIG",
				"GIT_CONFIG_COUNT",
				"GIT_CONFIG_PARAMETERS",
				"GIT_CONFIG_SYSTEM",
				"GIT_CONFIG_GLOBAL",
				"GIT_CONFIG_NOSYSTEM",
				"GIT_REPLACE_REF_BASE",
				"GIT_NO_REPLACE_OBJECTS",
				"GIT_SHALLOW_FILE",
			],
			(name) => Config.string(name).pipe(Config.option),
		);
		if (overrides.some(Option.isSome)) return undefined;
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
		// Base resolution scans remote refs; nested remote names are outside this fast path.
		if (/\[remote "[^"\n]*\//.test(config)) return undefined;
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
			const remoteCandidate = join(commonDir, `refs/remotes/${ref}`);
			if (
				(yield* fs.exists(remoteCandidate)) &&
				(yield* fs.stat(remoteCandidate)).type === "Directory"
			)
				return undefined;
			files.push(
				join(gitDir, ref),
				join(commonDir, ref),
				join(commonDir, `refs/${ref}`),
				join(commonDir, `refs/heads/${ref}`),
				join(commonDir, `refs/tags/${ref}`),
				join(commonDir, `refs/remotes/${ref}`),
			);
			const branch = ref.startsWith("refs/heads/")
				? ref.slice("refs/heads/".length)
				: ref;
			for (const remote of remotes)
				files.push(join(commonDir, `refs/remotes/${remote}/${branch}`));
			files.push(join(commonDir, `refs/remotes/origin/${branch}`));
		}
		const head = yield* optional(join(gitDir, "HEAD"));
		if (head === undefined) return undefined;
		if (head.startsWith("ref: ")) {
			const target = head.slice(5).trim();
			if (!target.startsWith("refs/heads/") || !sharedRef(target))
				return undefined;
			files.push(join(commonDir, target));
		} else if (!/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/.test(head.trim()))
			return undefined;
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
