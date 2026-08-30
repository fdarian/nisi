import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git } from "./exec.ts";
import type { OverviewCommit } from "./pull-request-overview.ts";
import { resolveHeadSha, resolveMergeBase } from "./repo.ts";

/**
 * `git log`'s `--pretty=format:` fields, delimited by ASCII unit/record
 * separators rather than anything printable — a commit body is free-form
 * text that routinely contains newlines (and, rarely, punctuation that would
 * collide with a printable delimiter), so this is the same reasoning
 * `content-diff.ts`'s patch parsing avoids ad hoc text delimiters for.
 * `%x1e` (record separator) trails every commit; `%x1f` (unit separator)
 * separates each commit's own fields. Body (`%b`) is last in the field list
 * so a stray `%x1f` inside one (git doesn't produce one, but nothing
 * enforces that) only widens the body instead of misaligning every field
 * after it.
 */
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";
const LOG_FIELDS = ["%H", "%h", "%s", "%an", "%cI", "%b"];
const LOG_FORMAT = `${LOG_FIELDS.join(FIELD_SEP)}${RECORD_SEP}`;

/**
 * Splits `git log`'s delimited stdout into one `OverviewCommit` per record.
 * `authorLogin`/`url`/`checks` are always `null` here — a plain `git log`
 * has no GitHub identity or CI data, unlike `pull-request-overview.ts`'s
 * GraphQL-backed reader, which is the one place those get populated.
 */
const parseCommitLog = (stdout: string): ReadonlyArray<OverviewCommit> =>
	stdout
		.split(RECORD_SEP)
		// `git log` separates consecutive records with a newline of its own on
		// top of the trailing `RECORD_SEP` this format already appends, and the
		// very last split segment is the empty tail after the final separator.
		.map((record) => record.replace(/^\n/, ""))
		.filter((record) => record.length > 0)
		.map((record) => {
			const [sha, shortSha, headline, authorName, committedDate, ...bodyParts] =
				record.split(FIELD_SEP);
			if (
				sha === undefined ||
				shortSha === undefined ||
				headline === undefined ||
				authorName === undefined ||
				committedDate === undefined
			) {
				throw new Error(
					`unparseable "git log" record: ${JSON.stringify(record)}`,
				);
			}
			// `%b` always carries git's own trailing newline after the last body
			// line (the raw commit object's message ends with exactly one) —
			// stripped here so an empty body decodes to `null` (matching
			// `pull-request-overview.ts`'s GraphQL `messageBody`, which GitHub
			// already returns without one) instead of `null`'s cousin, `"\n"`.
			const body = bodyParts.join(FIELD_SEP).replace(/\n+$/, "");
			return {
				sha,
				shortSha,
				headline,
				body: body === "" ? null : body,
				authorName,
				authorLogin: null,
				committedDate,
				url: null,
				checks: null,
			} satisfies OverviewCommit;
		});

/**
 * The Overview tab's branch/diff-mode data source: every commit in
 * `merge-base(baseRef, headRef)..headRef`, oldest-first — `--reverse`, since
 * plain `git log` is newest-first and the wire contract promises
 * chronological order, matching GitHub's own PR commits tab (and
 * `pull-request-overview.ts`'s GraphQL connection, which is chronological by
 * construction). Resolving `mergeBase`/`headSha` up front mirrors
 * `diff.ts`'s `getChangedFiles` — the same pair, for the same reason: a
 * caller-supplied `headRef` isn't guaranteed to be what `repoRoot`'s worktree
 * currently has checked out, so the range must be pinned to real commits
 * before `git log` runs, not left as ref names it re-resolves itself.
 */
export const fetchBranchCommits = (
	repoRoot: string,
	baseRef: string,
	headRef: string,
): Effect.Effect<
	ReadonlyArray<OverviewCommit>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> =>
	Effect.gen(function* () {
		const mergeBase = yield* resolveMergeBase(repoRoot, baseRef, headRef);
		const headSha = yield* resolveHeadSha(repoRoot, headRef);

		const stdout = yield* git(repoRoot, [
			"log",
			"--reverse",
			`--pretty=format:${LOG_FORMAT}`,
			`${mergeBase}..${headSha}`,
		]);

		return parseCommitLog(stdout);
	});
