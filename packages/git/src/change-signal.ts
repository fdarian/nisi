import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect, Option } from "effect";
import { FileSystem } from "effect/FileSystem";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git } from "./exec.ts";

/**
 * A sha256 of the file's bytes, computed only for the paths `git status`
 * already reports as dirty — never the whole tree, and never a file with
 * nothing to compare against, the same bound `readRepoChangeSignature`
 * already applied when this was `mtime`/`size` instead.
 *
 * It used to be `mtime`/`size` — cheaper, but provably unsound: two
 * different same-length writes that land on the same recorded mtime
 * collide on the signature exactly the way a real "nothing changed" tick
 * does, so the live-update poller silently never notices the edit. That's
 * not just a theoretical race — forcing an identical mtime via `utimes` on
 * two different same-size contents reproduces it every time (see
 * `test/change-signal.test.ts`), and real filesystems hand you that
 * collision for free: any mount with coarser-than-APFS timestamp
 * resolution (network shares, several container bind-mount drivers), or a
 * tool that preserves/resets a file's mtime on write (some formatters,
 * sync clients). Content-hashing trades that gap for reading the dirty
 * files' bytes every tick — bounded by how many paths are actually dirty
 * (never every changed file in the diff the way Codiff's own hashing
 * works, which is what this module was written to avoid), so the cost
 * stays proportional to what a human could plausibly be mid-editing, not
 * to the PR's total size.
 */
export type FileSignature = { readonly contentHash: string };

/** One repo's worth of cheap change signals: HEAD (catches commits) + per-path content hash (catches worktree edits). */
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

const hashBytes = (bytes: Uint8Array): string =>
	createHash("sha256").update(bytes).digest("hex");

/**
 * Reads the cheap change signature `git status --porcelain` reports for a
 * repo: HEAD's sha (catches new commits, which `status` alone can't) plus,
 * when `options.includeUncommitted` is `true`, a content hash for every path
 * `status` reports as touched (staged, unstaged, or untracked) — never any
 * path `status` doesn't mention, so this stays bounded by how much is
 * actually dirty, not the repo's total size. A missing path (e.g. a
 * signature read racing a deletion) is simply absent from `files` rather
 * than failing the read.
 *
 * `options?.includeUncommitted` (default `false`) mirrors `diff.ts`'s
 * `getChangedFiles`/`getFileContents` convention. With it `false` — the
 * common case, since it means the visible diff target is HEAD and worktree
 * dirt can't affect anything shown — `git status` and the hashing are
 * skipped entirely, not just discarded afterward: the signature is only
 * ever `headSha` with an empty `files` map. This package stays pure and
 * doesn't read the setting itself; the caller (the sidecar's live-poll)
 * resolves it and passes it in.
 */
export const readRepoChangeSignature = (
	repoRoot: string,
	options?: { readonly includeUncommitted?: boolean },
): Effect.Effect<
	RepoChangeSignature,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner | FileSystem
> =>
	Effect.gen(function* () {
		const includeUncommitted = options?.includeUncommitted ?? false;

		if (!includeUncommitted) {
			const headSha = yield* git(repoRoot, ["rev-parse", "HEAD"]).pipe(
				Effect.map((out) => out.trim()),
			);
			return { headSha, files: new Map() };
		}

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
				fs.readFile(join(repoRoot, path)).pipe(
					Effect.map(
						(bytes) => [path, { contentHash: hashBytes(bytes) }] as const,
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
		if (other === undefined || other.contentHash !== signature.contentHash) {
			return false;
		}
	}
	return true;
};
