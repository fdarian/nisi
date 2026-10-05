import { Effect } from "effect";
import { gitResult } from "./exec.ts";
import { resolveCurrentBranch } from "./repo.ts";
import { parseOwnerRepoFromRemoteUrl } from "./repo-path-mapping.ts";

/** A conservative index key, not another gh finder: unusual push setups stay on gh's path. */
export const readIndexHead = (repoRoot: string) =>
	Effect.gen(function* () {
		const inputs = yield* Effect.all(
			[
				resolveCurrentBranch(repoRoot),
				gitResult(repoRoot, [
					"config",
					"--null",
					"--get-regexp",
					"^(remote\\..*\\.(url|push)|branch\\..*\\.(remote|merge|pushremote)|remote\\.pushdefault|push\\.default|url\\..*\\.insteadof)$",
				]),
			],
			{ concurrency: "unbounded" },
		);
		const branch = inputs[0];
		const config = new Map<string, string>();
		for (const record of inputs[1].stdout.split("\0")) {
			const separator = record.indexOf("\n");
			if (separator < 0) continue;
			const key = record.slice(0, separator);
			if (key.startsWith("url.") || config.has(key)) return undefined;
			config.set(key, record.slice(separator + 1));
		}
		const origin = config.get("remote.origin.url");
		if (
			origin === undefined ||
			!/^(?:https?:\/\/(?:[^/@]+@)?github\.com\/|[^/@:]+@github\.com:|ssh:\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/)/i.test(
				origin,
			)
		)
			return undefined;
		const base = parseOwnerRepoFromRemoteUrl(origin);
		if (base === null) return undefined;
		if (branch === "HEAD") return undefined;
		const values = [
			config.get(`branch.${branch}.remote`),
			config.get(`branch.${branch}.merge`),
			config.get(`branch.${branch}.pushremote`),
			config.get("remote.pushdefault"),
			config.get("push.default"),
		];
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
		if (config.has(`remote.${remote}.push`)) return undefined;
		const url = config.get(`remote.${remote}.url`);
		if (url === undefined) return undefined;
		const head = parseOwnerRepoFromRemoteUrl(url);
		if (head === null) return undefined;
		return {
			owner: base.owner,
			repo: base.repo,
			headOwner: head.owner,
			branch,
		};
	});
