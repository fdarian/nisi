import { join } from "node:path";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git } from "./exec.ts";

/**
 * A cheap-to-compute stand-in for "did this file's content change" —
 * `mtime`/`size` instead of a content hash. Codiff content-hashes every
 * changed file (up to 64MB) on every poll tick; this is the signal that lets
 * the sidecar's live-update poller skip that entirely in the common case
 * where nothing moved.
 */
export type FileSignature = { readonly mtimeMs: number; readonly size: number };

/** One repo's worth of cheap change signals: HEAD (catches commits) + per-path mtime/size (catches worktree edits). */
export type RepoChangeSignature = {
	readonly headSha: string;
	readonly files: ReadonlyMap<string, FileSignature>;
};

/** Parses `git status --porcelain=v1 -z`'s NUL-separated output into the set of paths it reports. */
const parseStatusPaths = (raw: string): ReadonlyArray<string> => {
	const tokens = raw.split("\0").filter((token) => token.length > 0);
	const paths: Array<string> = [];
	let index = 0;
	while (index < tokens.length) {
		const record = tokens[index++];
		if (record === undefined) break;
		const code = record.slice(0, 2);
		const path = record.slice(3);
		// A rename/copy record's porcelain line is `XY new-path`, followed by
		// its own NUL-separated `orig-path` token — consume it too so the next
		// iteration doesn't misread it as an unrelated record.
		if (code[0] === "R" || code[0] === "C") {
			index++;
		}
		paths.push(path);
	}
	return paths;
};

/**
 * Reads the cheap change signature `git status --porcelain` reports for a
 * repo: HEAD's sha (catches new commits, which `status` alone can't) plus
 * `mtime`/`size` for every path `status` reports as touched (staged,
 * unstaged, or untracked). A missing path (e.g. a signature read racing a
 * deletion) is simply absent from `files` rather than failing the read.
 */
export const readRepoChangeSignature = (
	repoRoot: string,
): Effect.Effect<
	RepoChangeSignature,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem
> =>
	Effect.gen(function* () {
		const fs = yield* FileSystem;

		const [headSha, statusRaw] = yield* Effect.all([
			git(repoRoot, ["rev-parse", "HEAD"]).pipe(
				Effect.map((out) => out.trim()),
			),
			git(repoRoot, ["status", "--porcelain=v1", "-z"]),
		]);

		const paths = parseStatusPaths(statusRaw);
		const entries = yield* Effect.forEach(
			paths,
			(path) =>
				fs.stat(join(repoRoot, path)).pipe(
					Effect.map(
						(stat) =>
							[
								path,
								{
									mtimeMs: Option.getOrElse(
										stat.mtime,
										() => new Date(0),
									).getTime(),
									size: Number(stat.size),
								},
							] as const,
					),
					Effect.option,
				),
			{ concurrency: "unbounded" },
		);

		const files = new Map<string, FileSignature>();
		for (const entry of entries) {
			if (Option.isSome(entry)) files.set(entry.value[0], entry.value[1]);
		}

		return { headSha, files };
	});

/** Whether two signatures indicate the repo's changed files have actually moved — new/removed/edited paths, or a new HEAD. */
export const repoChangeSignatureEquals = (
	a: RepoChangeSignature,
	b: RepoChangeSignature,
): boolean => {
	if (a.headSha !== b.headSha) return false;
	if (a.files.size !== b.files.size) return false;
	for (const [path, signature] of a.files) {
		const other = b.files.get(path);
		if (
			other === undefined ||
			other.mtimeMs !== signature.mtimeMs ||
			other.size !== signature.size
		) {
			return false;
		}
	}
	return true;
};
