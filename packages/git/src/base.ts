import { Effect } from "effect";
import { git, gitResult } from "./exec.ts";

export const resolveBaseRemote = (repoRoot: string) =>
	Effect.gen(function* () {
		const remotes = (yield* git(repoRoot, ["remote"]))
			.trim()
			.split("\n")
			.filter((remote) => remote.length > 0);
		return remotes.includes("origin") ? "origin" : (remotes.at(0) ?? null);
	});

const resolveBaseTarget = (repoRoot: string, baseRef: string) =>
	Effect.gen(function* () {
		const remote = yield* resolveBaseRemote(repoRoot);
		if (remote === null) return { ref: baseRef, remote: null, branch: null };
		const prefix = `refs/remotes/${remote}/`;
		if (baseRef.startsWith(prefix) || baseRef.startsWith(`${remote}/`)) {
			const branch = baseRef.slice(
				baseRef.startsWith(prefix) ? prefix.length : remote.length + 1,
			);
			return { ref: `${prefix}${branch}`, remote, branch };
		}
		const branch = baseRef.startsWith("refs/heads/")
			? baseRef.slice("refs/heads/".length)
			: baseRef;
		const local = yield* gitResult(repoRoot, [
			"show-ref",
			"--verify",
			"--quiet",
			`refs/heads/${branch}`,
		]);
		const resolved = yield* gitResult(repoRoot, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${baseRef}^{commit}`,
		]);
		// Explicit tags, SHAs and revision expressions keep their local-diff meaning.
		if (local.exitCode !== 0 && resolved.exitCode === 0)
			return { ref: baseRef, remote: null, branch: null };
		return { ref: `${prefix}${branch}`, remote, branch };
	});

export const resolveDiffBaseRef = (repoRoot: string, baseRef: string) =>
	resolveBaseTarget(repoRoot, baseRef).pipe(Effect.map((target) => target.ref));

/** An explicit destination prevents even unusual remote fetch configuration from moving a local branch. */
export const fetchBaseRef = (repoRoot: string, baseRef: string) =>
	Effect.gen(function* () {
		const target = yield* resolveBaseTarget(repoRoot, baseRef);
		if (target.remote === null || target.branch === null)
			return { baseRef: target.ref, baseMayBeStale: false };
		const baseMayBeStale = yield* git(repoRoot, [
			"fetch",
			"--no-tags",
			"--refmap=",
			target.remote,
			`+refs/heads/${target.branch}:${target.ref}`,
		]).pipe(
			Effect.as(false),
			Effect.catchTag("GitCommandError", (error) =>
				Effect.logWarning("Base fetch failed; base may be stale", {
					repoRoot,
					baseRef: target.ref,
					error,
				}).pipe(Effect.as(true)),
			),
		);
		// A failed first fetch must be an error, never a local-branch fallback.
		yield* git(repoRoot, ["rev-parse", "--verify", `${target.ref}^{commit}`]);
		return { baseRef: target.ref, baseMayBeStale };
	});
