import { Effect } from "effect";
import { gitResult } from "./exec.ts";
import { originUrlOrNull, resolveCurrentBranch } from "./repo.ts";
import { parseOwnerRepoFromRemoteUrl } from "./repo-path-mapping.ts";

/** A conservative index key, not another gh finder: unusual push setups stay on gh's path. */
export const readIndexHead = (repoRoot: string) =>
	Effect.gen(function* () {
		const origin = yield* originUrlOrNull(repoRoot);
		if (
			origin === null ||
			!/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|[^/@:]+@github\.com:|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/)/i.test(
				origin,
			)
		)
			return undefined;
		const base = parseOwnerRepoFromRemoteUrl(origin);
		if (base === null) return undefined;
		const branch = yield* resolveCurrentBranch(repoRoot);
		if (branch === "HEAD") return undefined;
		const config = (key: string) =>
			gitResult(repoRoot, ["config", "--get", key]).pipe(
				Effect.map((result) =>
					result.exitCode === 0 ? result.stdout.trim() : undefined,
				),
			);
		const values = yield* Effect.all(
			[
				config(`branch.${branch}.remote`),
				config(`branch.${branch}.merge`),
				config(`branch.${branch}.pushRemote`),
				config("remote.pushDefault"),
				config("push.default"),
			],
			{ concurrency: "unbounded" },
		);
		const remote = values[0];
		if (
			remote === undefined ||
			remote === "." ||
			values[1] !== `refs/heads/${branch}` ||
			values[2] !== undefined ||
			values[3] !== undefined ||
			(values[4] !== undefined &&
				values[4] !== "simple" &&
				values[4] !== "current" &&
				values[4] !== "upstream")
		)
			return undefined;
		const pushRules = yield* gitResult(repoRoot, [
			"config",
			"--get-all",
			`remote.${remote}.push`,
		]);
		if (pushRules.exitCode === 0) return undefined;
		const url = yield* gitResult(repoRoot, ["remote", "get-url", remote]);
		if (url.exitCode !== 0) return undefined;
		const head = parseOwnerRepoFromRemoteUrl(url.stdout.trim());
		if (head === null) return undefined;
		return {
			owner: base.owner,
			repo: base.repo,
			headOwner: head.owner,
			branch,
		};
	});
