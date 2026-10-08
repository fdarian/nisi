import { BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { verifyRepoPathMatchesOrigin } from "../../src/repo-path-mapping.ts";
import { repointOriginToMovedRepo } from "../../src/repoint-origin.ts";

const mode = process.argv[2];
const path = process.argv[3];
const owner = process.argv[4];
const repo = process.argv[5];
if (
	(mode !== "verify" && mode !== "repoint") ||
	path === undefined ||
	owner === undefined ||
	repo === undefined
) {
	throw new Error(
		"usage: repoint-origin-runner.ts <verify|repoint> <path> <owner> <repo>",
	);
}

const program =
	mode === "verify"
		? verifyRepoPathMatchesOrigin(path, owner, repo, { detectMovedRepo: true })
		: repointOriginToMovedRepo({ path, owner, repo });

const result = await Effect.runPromise(
	program.pipe(Effect.result, Effect.provide(BunServices.layer)),
);

if (result._tag === "Success") {
	console.log(JSON.stringify({ ok: true as const, root: result.success }));
} else {
	console.log(
		JSON.stringify({
			ok: false as const,
			tag: result.failure._tag,
			movedOnGitHub:
				result.failure._tag === "RepoPathOriginMismatch"
					? result.failure.movedOnGitHub
					: null,
		}),
	);
}
