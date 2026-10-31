import { createHash } from "node:crypto";
import { join } from "node:path";
import { Effect } from "effect";
import { GuideFolderUnresolvable } from "./errors.ts";
import { git } from "./exec.ts";
import { GitHub } from "./github/github.ts";
import {
	originUrlOrNull,
	resolveCurrentBranch,
	resolveHeadSha,
} from "./repo.ts";
import { parseOwnerRepoFromRemoteUrl } from "./repo-path-mapping.ts";
import { headRefOfWorktreeBranch } from "./worktree.ts";

const DETACHED_HEAD = "HEAD";

const parsedOrigin = (repoRoot: string) =>
	originUrlOrNull(repoRoot).pipe(
		Effect.map((url) =>
			url === null ? null : parseOwnerRepoFromRemoteUrl(url),
		),
	);

/** Keyed on the common dir so every worktree of one clone shares a key. */
const localRepoKey = (repoRoot: string) =>
	git(repoRoot, [
		"rev-parse",
		"--path-format=absolute",
		"--git-common-dir",
	]).pipe(
		Effect.map(
			(stdout) =>
				`local/${createHash("sha256").update(stdout.trim()).digest("hex").slice(0, 16)}`,
		),
	);

/** `owner/repo`, lowercased because GitHub treats them case-insensitively; `local/<hash>` when there is no usable origin. */
const repoKey = (repoRoot: string) =>
	parsedOrigin(repoRoot).pipe(
		Effect.flatMap((origin) =>
			origin === null
				? localRepoKey(repoRoot)
				: Effect.succeed(`${origin.owner}/${origin.repo}`.toLowerCase()),
		),
	);

/** The branch is URL-encoded into one segment so `a` and `a/b` can't nest inside each other. */
const folderFor = (guidesDir: string, key: string, branch: string) =>
	join(guidesDir, key, encodeURIComponent(headRefOfWorktreeBranch(branch)));

/**
 * The guide folder of the branch a session reviews. Never touches the network:
 * a detached-`HEAD` branch session names no branch, so there is no folder
 * (`null`).
 */
export const sessionGuideFolder = (
	guidesDir: string,
	repoRoot: string,
	headRef: string,
) =>
	Effect.gen(function* () {
		if (headRef === DETACHED_HEAD) return null;
		return folderFor(guidesDir, yield* repoKey(repoRoot), headRef);
	});

const unresolvable = (repoRoot: string, why: string) =>
	new GuideFolderUnresolvable({
		repoRoot,
		message: `${why} Check out the PR's branch (git switch <branch>) and run this again.`,
	});

/**
 * The guide folder for what `repoRoot` has checked out: its current branch,
 * or, when `HEAD` is detached, the head ref of the one open PR GitHub says
 * contains `HEAD`. Anything other than exactly one is an error rather than a
 * guess.
 */
export const checkoutGuideFolder = (guidesDir: string, repoRoot: string) =>
	Effect.gen(function* () {
		const branch = yield* resolveCurrentBranch(repoRoot);
		const key = yield* repoKey(repoRoot);
		if (branch !== DETACHED_HEAD) return folderFor(guidesDir, key, branch);

		const origin = yield* parsedOrigin(repoRoot);
		if (origin === null) {
			return yield* unresolvable(
				repoRoot,
				"HEAD is detached and this repository has no origin to ask which PR it belongs to.",
			);
		}
		const sha = yield* resolveHeadSha(repoRoot);
		const github = yield* GitHub;
		const pulls = yield* github.pullRequestsContainingCommit(
			repoRoot,
			origin.owner,
			origin.repo,
			sha,
		);
		const open = pulls.filter((pull) => pull.state === "OPEN");
		const only = open[0];
		if (only === undefined || open.length > 1) {
			return yield* unresolvable(
				repoRoot,
				open.length === 0
					? `HEAD is detached and no open PR contains ${sha.slice(0, 7)}.`
					: `HEAD is detached and ${open.length} open PRs (${open.map((pull) => `#${pull.number}`).join(", ")}) contain ${sha.slice(0, 7)}.`,
			);
		}
		return folderFor(guidesDir, key, only.headRef);
	});
