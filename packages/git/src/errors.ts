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

/** `gh repo view` reported no default branch — an empty repository with no commits. */
export class NoDefaultBranch extends Schema.TaggedErrorClass<NoDefaultBranch>()(
	"NoDefaultBranch",
	{ owner: Schema.String, repo: Schema.String },
) {}

/** `diff.file` was asked for a path that isn't part of the current diff. */
export class FileNotChanged extends Schema.TaggedErrorClass<FileNotChanged>()(
	"FileNotChanged",
	{ path: Schema.String },
) {}

export type GitError =
	| GitCommandError
	| NotAGitRepository
	| GhOutputDecodeError
	| NoDefaultBranch;
