import { Schema } from "effect";

/**
 * A `git`/`gh` invocation didn't produce usable output — either it never
 * started (binary missing, permissions) or it exited non-zero. `exitCode` is
 * `null` for the former, so callers can tell "never ran" apart from "ran and
 * failed" without guessing from a sentinel number.
 */
export class GitCommandError extends Schema.TaggedErrorClass<GitCommandError>()(
	"GitCommandError",
	{
		command: Schema.String,
		args: Schema.Array(Schema.String),
		cwd: Schema.String,
		exitCode: Schema.NullOr(Schema.Number),
		stderr: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/** `cwd` (or an ancestor) isn't inside a git working tree. */
export class NotAGitRepository extends Schema.TaggedErrorClass<NotAGitRepository>()(
	"NotAGitRepository",
	{ cwd: Schema.String },
) {}

/** `gh`'s `--json` output didn't parse or didn't match the shape we expect. */
export class GhOutputDecodeError extends Schema.TaggedErrorClass<GhOutputDecodeError>()(
	"GhOutputDecodeError",
	{
		command: Schema.String,
		raw: Schema.String,
		cause: Schema.Defect(),
	},
) {}

/**
 * Nothing in the repo names a branch to review against — neither GitHub nor
 * the repo's own refs (`origin/HEAD`, `init.defaultBranch`, `main`,
 * `master`). An empty repository with no commits is the usual cause.
 */
export class NoDefaultBranch extends Schema.TaggedErrorClass<NoDefaultBranch>()(
	"NoDefaultBranch",
	{ repoRoot: Schema.String },
) {}

/**
 * `gh` couldn't *ask* GitHub — the binary is missing, the user isn't
 * authenticated, or the API is unreachable. Deliberately distinct from
 * GitHub answering "no such repository", which is a normal local-only
 * review target (see `resolveReviewTarget`) rather than a failure.
 */
export class GitHubUnreachable extends Schema.TaggedErrorClass<GitHubUnreachable>()(
	"GitHubUnreachable",
	{ repoRoot: Schema.String, reason: Schema.String },
) {}

/**
 * A path turned out not to be part of the current diff. `getFileContents`
 * (`diff.ts`) never raises this itself — a path missing from a batch is
 * simply absent from its result map — so this exists for callers that need
 * fail-fast, single-path semantics on top of that (e.g.
 * `apps/desktop/sidecar/walkthrough/context.ts`'s `gatherGenerationContext`,
 * which constructs one manually when a requested path comes back missing).
 */
export class FileNotChanged extends Schema.TaggedErrorClass<FileNotChanged>()(
	"FileNotChanged",
	{ path: Schema.String },
) {}

export type GitError =
	| GitCommandError
	| NotAGitRepository
	| GhOutputDecodeError
	| NoDefaultBranch
	| GitHubUnreachable;
