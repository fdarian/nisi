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
		const results = yield* Effect.all(
			[
				resolveBaseRemote(repoRoot),
				git(repoRoot, [
					"for-each-ref",
					"--format=%(refname)%09%(objectname)%09%(objecttype)%09%(*objectname)%09%(*objecttype)",
					baseRef.startsWith("refs/") ? baseRef : `refs/heads/${baseRef}`,
					`refs/tags/${baseRef}`,
					`refs/remotes/*/${baseRef}`,
					`refs/remotes/${baseRef}`,
				]),
			],
			{ concurrency: "unbounded" },
		);
		const refs = new Map(
			results[1]
				.trim()
				.split("\n")
				.filter((line) => line.length > 0)
				.map((line) => {
					const fields = line.split("\t");
					return [
						fields[0],
						fields[2] === "commit"
							? fields[1]
							: fields[4] === "commit"
								? fields[3]
								: undefined,
					] as const;
				}),
		);
		const remote = results[0];
		if (remote === null)
			return {
				ref: baseRef,
				remote: null,
				branch: null,
				commit:
					refs.get(baseRef) ??
					refs.get(`refs/heads/${baseRef}`) ??
					refs.get(`refs/tags/${baseRef}`),
			};
		const prefix = `refs/remotes/${remote}/`;
		if (baseRef.startsWith(prefix) || baseRef.startsWith(`${remote}/`)) {
			const branch = baseRef.slice(
				baseRef.startsWith(prefix) ? prefix.length : remote.length + 1,
			);
			return {
				ref: `${prefix}${branch}`,
				remote,
				branch,
				commit: refs.get(`${prefix}${branch}`),
			};
		}
		const branch = baseRef.startsWith("refs/heads/")
			? baseRef.slice("refs/heads/".length)
			: baseRef;
		const local = refs.has(`refs/heads/${branch}`);
		// Explicit tags, SHAs and revision expressions keep their local-diff meaning.
		if (!local) {
			const known = refs.get(baseRef) ?? refs.get(`refs/tags/${baseRef}`);
			if (known !== undefined)
				return { ref: baseRef, remote: null, branch: null, commit: known };
			const resolved = yield* gitResult(repoRoot, [
				"rev-parse",
				"--verify",
				"--quiet",
				`${baseRef}^{commit}`,
			]);
			if (resolved.exitCode === 0)
				return {
					ref: baseRef,
					remote: null,
					branch: null,
					commit: resolved.stdout.trim(),
				};
		}
		const ref = `${prefix}${branch}`;
		return { ref, remote, branch, commit: refs.get(ref) };
	});

export const resolveDiffBaseRef = (repoRoot: string, baseRef: string) =>
	resolveBaseTarget(repoRoot, baseRef).pipe(Effect.map((target) => target.ref));

export const readLocalBase = (repoRoot: string, baseRef: string) =>
	Effect.gen(function* () {
		const target = yield* resolveBaseTarget(repoRoot, baseRef);
		const ref = target.ref;
		if (target.commit !== undefined)
			return { baseRef: ref, commit: target.commit };
		const result = yield* gitResult(repoRoot, [
			"rev-parse",
			"--verify",
			"--quiet",
			`${ref}^{commit}`,
		]);
		return {
			baseRef: ref,
			commit: result.exitCode === 0 ? result.stdout.trim() : null,
		};
	});

export const readLocalBaseCommit = (repoRoot: string, baseRef: string) =>
	readLocalBase(repoRoot, baseRef).pipe(Effect.map((local) => local.commit));

/** An explicit destination prevents even unusual remote fetch configuration from moving a local branch. */
export const fetchBaseRef = (repoRoot: string, baseRef: string) =>
	Effect.gen(function* () {
		const target = yield* resolveBaseTarget(repoRoot, baseRef);
		if (target.remote === null || target.branch === null)
			return { baseRef: target.ref, baseMayBeStale: false };
		const baseMayBeStale = yield* git(repoRoot, [
			"fetch",
			"--no-tags",
			"--no-write-fetch-head",
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
