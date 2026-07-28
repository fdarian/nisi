import { Effect } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type { GitCommandError } from "./errors.ts";
import { git } from "./exec.ts";

export type FileCategory = "implementation" | "test" | "generated";

/**
 * Nothing downstream of Linguist has a "test" concept, and the one JS port
 * only regex-scrapes filename patterns — so test detection instead reuses
 * Jest's `testMatch` / Vitest's `include` defaults verbatim (hand-expanded
 * out of extglob syntax, which `Bun.Glob` doesn't support, into brace
 * alternation, which it does).
 */
const TEST_GLOBS = [
	"**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
	"**/*.test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
	"**/*.spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
	"**/test.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
	"**/spec.{js,jsx,ts,tsx,mjs,cjs,mts,cts}",
].map((pattern) => new Bun.Glob(pattern));

const GENERATED_GLOBS = ["**/*.min.*", "**/*.map"].map(
	(pattern) => new Bun.Glob(pattern),
);

/** Filenames whose entire purpose is being machine-written; never hand-authored. */
const LOCKFILE_NAMES = new Set([
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lock",
	"bun.lockb",
	"Cargo.lock",
	"Gemfile.lock",
	"poetry.lock",
	"composer.lock",
	"go.sum",
	"mix.lock",
	"flake.lock",
	"Pipfile.lock",
]);

const GENERATED_CONTENT_MARKERS = [
	// Go's convention (https://go.dev/s/generatedcode) — also adopted elsewhere.
	/^.{0,3}Code generated .* DO NOT EDIT\.?$/m,
	/@generated\b/,
];

const isLockfile = (path: string) =>
	LOCKFILE_NAMES.has(path.slice(path.lastIndexOf("/") + 1));

const matchesAnyGlob = (globs: ReadonlyArray<Bun.Glob>, path: string) =>
	globs.some((glob) => glob.match(path));

const hasGeneratedMarker = (contentPrefix: string) =>
	GENERATED_CONTENT_MARKERS.some((pattern) => pattern.test(contentPrefix));

/**
 * Pure classification from signals already gathered for one file.
 * `contentPrefix` is the start of the file's current content, when cheaply
 * available — `undefined` (e.g. for deletions, or content past the size
 * gate) just means the content-marker signal is skipped, not that the file
 * is assumed to be anything in particular.
 */
export const classifyFile = (input: {
	readonly path: string;
	readonly linguistGenerated: boolean;
	readonly contentPrefix?: string | undefined;
}): FileCategory => {
	if (
		input.linguistGenerated ||
		isLockfile(input.path) ||
		matchesAnyGlob(GENERATED_GLOBS, input.path) ||
		(input.contentPrefix !== undefined &&
			hasGeneratedMarker(input.contentPrefix))
	) {
		return "generated";
	}
	if (matchesAnyGlob(TEST_GLOBS, input.path)) {
		return "test";
	}
	return "implementation";
};

/**
 * `git check-attr linguist-generated`, batched into one `--stdin -z` call
 * instead of one subprocess per path.
 */
export const checkLinguistGenerated = (
	repoRoot: string,
	paths: ReadonlyArray<string>,
): Effect.Effect<
	ReadonlySet<string>,
	GitCommandError,
	ChildProcessSpawner.ChildProcessSpawner
> => {
	if (paths.length === 0) {
		return Effect.succeed(new Set());
	}

	const input = paths.map((path) => `${path}\0`).join("");
	return git(
		repoRoot,
		["check-attr", "--stdin", "-z", "linguist-generated"],
		input,
	).pipe(
		Effect.map((raw) => {
			const tokens = raw.split("\0").filter((token) => token.length > 0);
			const generated = new Set<string>();
			for (let index = 0; index + 2 < tokens.length; index += 3) {
				const path = tokens[index];
				const value = tokens[index + 2];
				if (path !== undefined && (value === "set" || value === "true")) {
					generated.add(path);
				}
			}
			return generated;
		}),
	);
};
